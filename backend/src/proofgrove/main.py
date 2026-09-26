"""FastAPI application entrypoint for the Evaluation Hub."""

import asyncio
import logging
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from proofgrove.api.health import router as health_router
from proofgrove.api.v1.agents import router as agents_router
from proofgrove.api.v1.datasets import router as datasets_router
from proofgrove.api.v1.evaluation import router as evaluation_router
from proofgrove.api.v1.llms import router as llms_router
from proofgrove.api.v1.model_providers import router as model_providers_router
from proofgrove.api.v1.platform import router as platform_router
from proofgrove.api.v1.tracing import router as tracing_router
from proofgrove.db.session import async_session, init_db
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.target.invocation_span import setup_invocation_tracing
from proofgrove.logging_config import configure_logging
from proofgrove.platform.authz import AuthorizationMiddleware
from proofgrove.platform.rate_limit import RateLimitMiddleware
from proofgrove.runs_worker import run_worker_loop
from proofgrove.settings import settings
from proofgrove.tracing.index_worker import trace_index_worker_loop

configure_logging(settings.app_log_level)
logger = logging.getLogger(__name__)


class PayloadGovernanceMiddleware:
    """Reject oversized HTTP requests before they enter an evaluation workflow.

    Pure ASGI (not BaseHTTPMiddleware): BaseHTTPMiddleware is known to turn
    endpoint exceptions into bare text ``Internal Server Error`` responses that
    bypass FastAPI's JSON exception handlers.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        length = headers.get("content-length")
        if length is not None:
            try:
                if int(length) > settings.max_request_body_bytes:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "request payload exceeds the configured limit"},
                    )
                    await response(scope, receive, send)
                    return
            except ValueError:
                response = JSONResponse(
                    status_code=400,
                    content={"detail": "invalid content-length header"},
                )
                await response(scope, receive, send)
                return
            await self.app(scope, receive, send)
            return

        # No Content-Length (e.g. chunked transfer encoding) -- the check above
        # never runs, so without this a client can stream an unbounded body
        # straight past it. Drain messages ourselves and stop the moment the
        # cap is crossed, instead of trusting a downstream body reader to
        # notice: FastAPI's own JSON-body parsing wraps `receive` errors into
        # a generic 400 ("There was an error parsing the body"), which would
        # swallow a cap raised from inside it. Buffering is bounded by the
        # same cap -- a request within it is read in full either way, and one
        # over it is cut off as soon as that's detected, not drained to the end.
        limit = settings.max_request_body_bytes
        buffered: list[dict] = []
        seen = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] == "http.request":
                seen += len(message.get("body") or b"")
                if seen > limit:
                    response = JSONResponse(
                        status_code=413,
                        content={"detail": "request payload exceeds the configured limit"},
                    )
                    await response(scope, receive, send)
                    return
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                # The client is already gone -- there's no one to send a
                # response to. Replaying this into the app would surface as
                # a ClientDisconnect exception mid-body-read, logged as an
                # unhandled-error stack trace for what is just a normal
                # client-hung-up-mid-upload, not a crash.
                return

        index = 0

        async def replay_receive() -> dict:
            nonlocal index
            if index < len(buffered):
                message = buffered[index]
                index += 1
                return message
            return await receive()

        await self.app(scope, replay_receive, send)


def _log_worker_exit(task: asyncio.Task) -> None:
    """A lifespan worker that dies takes its queue with it; say so loudly.

    ``create_task`` retrieves nothing on its own, so an exception in the run
    worker used to surface only at shutdown while every submitted job sat
    pending behind a green readiness probe. The probe reads the same task set
    (see ``api/health.py``) and reports the process not ready.
    """
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.critical("proofgrove: background worker %s exited", task.get_name(), extra={"error_type": type(exc).__name__})


def _start_worker(app: FastAPI, name: str, coroutine) -> asyncio.Task:
    task = asyncio.create_task(coroutine, name=name)
    task.add_done_callback(_log_worker_exit)
    app.state.background_workers[name] = task
    return task


async def _drain_workers(workers: dict[str, asyncio.Task], grace_seconds: float) -> None:
    """Give the workers one bounded chance to finish, then cancel what is left.

    ``grace_seconds`` is the whole budget: the cooperative wait, then the
    cancellation and whatever cleanup a cancelled worker does. A task still
    pending when the budget is spent is named and left to end with the
    process -- this function never waits past the deadline. The compatibility
    worker only re-checks ``stop`` between iterations and an iteration can be
    an entire evaluation, so an unbounded wait meant Kubernetes killed the pod
    mid-write instead. Cancelling stops the awaiting task, not a thread already
    executing inside it; that thread ends with the process, and its job stays
    RUNNING for the next owner's recovery, exactly as after a crash.
    """
    pending = [task for task in workers.values() if not task.done()]
    if not pending:
        return
    loop = asyncio.get_running_loop()
    deadline = loop.time() + grace_seconds
    _done, unfinished = await asyncio.wait(pending, timeout=grace_seconds)
    for task in unfinished:
        logger.warning("proofgrove: background worker %s did not stop within %.0fs; cancelling", task.get_name(), grace_seconds)
        task.cancel()
    if unfinished:
        _done, still_running = await asyncio.wait(unfinished, timeout=max(0.0, deadline - loop.time()))
        for task in still_running:
            logger.error("proofgrove: background worker %s is still running at the shutdown deadline; process exit ends it", task.get_name())


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: create tables, seed definitions, start the async run worker."""
    await init_db()
    async with async_session() as session:
        store = EvaluationStore(session)
        await store.seed_definitions()
    logger.info("database initialised", extra={"tables": "created", "catalogs": "seeded"})
    if setup_invocation_tracing():
        logger.info("proofgrove: evaluation root-span export enabled")

    stop = asyncio.Event()
    app.state.background_workers = {}
    async with AsyncExitStack() as stack:
        if settings.evaluation_runtime == "temporal":
            from proofgrove.orchestrator.temporal import reconcile_pending_run_jobs_loop, temporal_worker

            client = await stack.enter_async_context(temporal_worker())
            logger.info("proofgrove: Temporal evaluation worker started")
            if client is not None:
                _start_worker(app, "temporal-reconciler", reconcile_pending_run_jobs_loop(client, stop))
        else:
            _start_worker(app, "run-worker", run_worker_loop(stop))
            logger.info("proofgrove: local compatibility worker started")
        if settings.trace_index_enabled:
            _start_worker(app, "trace-index-worker", trace_index_worker_loop(stop))
            logger.info("proofgrove: trace index worker started")
        try:
            yield
        finally:
            stop.set()
            await _drain_workers(app.state.background_workers, settings.worker_shutdown_grace_seconds)
            # The registry outlives this lifespan on the module-level app; a
            # later probe must not report workers that were stopped on purpose.
            app.state.background_workers = {}


async def _json_http_exception_handler(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


async def _json_validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    detail = jsonable_encoder(exc.errors(), custom_encoder={ValueError: str})
    return JSONResponse(status_code=422, content={"detail": detail})


async def _json_unhandled_handler(request: Request, exc: Exception) -> JSONResponse:
    if isinstance(exc, (HTTPException, StarletteHTTPException)):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    # Keep raw exception details out of both responses and operational logs.
    logger.error("Unhandled error on %s %s", request.method, request.url.path, extra={"error_type": type(exc).__name__})
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


app = FastAPI(
    title="Proofgrove",
    description="Local AI evaluation workbench: datasets, deterministic metrics, optional LLM judges, experiments, review and SQLite persistence.",
    version="0.2.0",
    lifespan=lifespan,
    exception_handlers={
        StarletteHTTPException: _json_http_exception_handler,
        RequestValidationError: _json_validation_handler,
        Exception: _json_unhandled_handler,
    },
)

# Starlette wraps the stack so the LAST middleware added is the OUTERMOST one
# (it sees the request first and the response last). CORS must be added last
# so it wraps every other middleware -- otherwise a short-circuited response
# (401 from auth, 429 from rate-limit, 413 from the payload cap) never passes
# back through CORSMiddleware and ships with no CORS headers.
app.add_middleware(PayloadGovernanceMiddleware)
app.add_middleware(RateLimitMiddleware, config=settings)
app.add_middleware(AuthorizationMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(agents_router)
app.include_router(datasets_router)
app.include_router(evaluation_router)
app.include_router(llms_router)
app.include_router(model_providers_router)
app.include_router(platform_router)
app.include_router(tracing_router)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "proofgrove.main:app",
        host="127.0.0.1",
        port=settings.app_port,
        reload=settings.app_env == "dev",
    )
