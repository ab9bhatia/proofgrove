"""Application configuration using pydantic-settings."""

from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings

from proofgrove.configs.app_config import apply_telemetry_profile

_LOCAL_DATABASE_URL = "sqlite+aiosqlite:///./data/eval-ai.db"


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    app_env: str = "dev"
    app_port: int = 8010
    app_log_level: str = "INFO"
    evaluation_runtime: Literal["local", "temporal"] = "local"
    # Durable cancellation fallback for runs whose API request and executor do
    # not share an in-process task registry (multiple replicas / Temporal).
    evaluation_cancel_poll_seconds: float = 0.5
    # How long shutdown waits for the lifespan workers (compatibility run
    # worker, trace-index worker) to finish their current iteration before
    # cancelling them. Must stay under the pod's terminationGracePeriodSeconds
    # (30s by default) so the ASGI server still gets to close connections; an
    # iteration cut short leaves its job RUNNING for the next owner's recovery.
    worker_shutdown_grace_seconds: float = 20.0
    temporal_host: str = "temporal-frontend.evalai-platform.svc.cluster.local:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str = "proofgrove"
    # The run-job activity has a 26h start_to_close_timeout (workflows.py) to
    # cover the default 24h late-telemetry enrichment window, but a single
    # `await process_run_job(...)` call with no heartbeats gives Temporal no
    # way to notice a stalled worker, and no way to *deliver* a cancellation
    # request into the running activity -- cancellation is only relayed on a
    # heartbeat. Must stay well under temporal_activity_heartbeat_timeout_seconds.
    temporal_activity_heartbeat_seconds: float = 30.0
    temporal_activity_heartbeat_timeout_seconds: float = 120.0
    # A job row is committed before its workflow is started, so a start that
    # fails (or whose reply is lost) leaves a pending row. A supervised loop
    # resubmits pending rows that carry no submission mark and are older than
    # ``temporal_reconcile_after_seconds`` -- old enough that the request that
    # created them is no longer in flight -- every ``temporal_reconcile_interval_seconds``.
    temporal_reconcile_interval_seconds: float = 30.0
    temporal_reconcile_after_seconds: float = 60.0
    # Development and test use SQLAlchemy's metadata bootstrap. Production must
    # run `alembic upgrade head` as a deployment step instead.
    database_auto_create: bool = False
    platform_auth_required: bool = False
    authz_service_url: str = "http://authz-service.evalai-authz.svc.cluster.local:8080"
    authz_check_token: SecretStr = SecretStr("")
    # Match the application ID used by the tenant catalog and its role grants.
    authz_app_name: str = "proofgrove"
    authz_timeout_seconds: float = 2.0
    max_request_body_bytes: int = 1_048_576
    max_persisted_sample_chars: int = 20_000
    payload_redaction_enabled: bool = True

    # Envoy/Redis is the authoritative distributed limiter for public routes.
    # This process-local Phoenix-style token bucket protects the ClusterIP path
    # used by the UI BFF and other explicitly allowed in-tenant callers.
    rate_limit_enabled: bool = False
    rate_limit_requests_per_minute: int = 120
    rate_limit_burst: int = 30
    rate_limit_max_buckets: int = 10_000
    rate_limit_bucket_ttl_seconds: float = 600.0

    # CORS
    cors_origins: list[str] = ["http://localhost:3010", "http://127.0.0.1:3010"]

    # Relational store (product-agnostic). Dialect is taken from DATABASE_URL
    # unless DATABASE_BACKEND overrides it. PostgreSQL remains the default and
    # the only officially supported production backend (ADR-26-05-13); other
    # SQLAlchemy dialects are selected by URL + optional driver extras.
    database_url: str = _LOCAL_DATABASE_URL
    database_backend: str | None = None

    # LLM judge
    judge_mode: Literal["auto", "llm", "mock"] = "mock"
    # Which backend the LLMJudge talks to.
    #   openai  -> standard OpenAI-compatible endpoint (Bearer auth)
    #   azure   -> Azure OpenAI (api-key header + api-version query param)
    #   compass -> Compass (api.core42.ai); gpt-5 family params
    judge_provider: Literal["openai", "azure", "compass"] = "openai"
    judge_model: str = "gpt-4o-mini"
    # Embedding model for metrics scored by cosine rather than by opinion
    # (llm.similarity). Routed through the same AI Gateway as the judge, so it
    # needs no separate credential — but it does need to be a routable id in
    # the platform aiGateway.modelRoutes catalogue. It is present in the shared
    # catalogue and absent from the local Kind override, which trims the list
    # to fit the AIGatewayRoute 15-rule cap; there the call fails and the
    # dispatcher discloses a fallback to the native judge. Empty disables the
    # embedding path and leaves those metrics on the native judge outright.
    judge_embedding_model: str = "text-embedding-3-large"
    judge_max_tokens: int = 800
    judge_temperature: float = 0.0

    # Route metrics to their third-party scoring framework (RAGAS / DeepEval)
    # when its adapter is declared on the metric. Requires the `frameworks`
    # extra to be installed; the engine falls back to the native judge per
    # metric when a framework is missing or a scoring call fails. Set to False
    # to force the native judge for every metric.
    judge_use_frameworks: bool = True
    evaluator_allow_native_fallback: bool = True

    # OpenAI / Compass (OpenAI-compatible) settings
    openai_api_key: SecretStr = SecretStr("")
    openai_base_url: str = "https://api.openai.com/v1"
    # JSON map for gateway headers, e.g. {"x-model-id": "gpt-4o"}

    # Azure OpenAI settings (used when judge_provider="azure")
    azure_openai_api_key: SecretStr = SecretStr("")
    azure_openai_endpoint: str = ""
    azure_openai_deployment: str = ""
    azure_openai_api_version: str = "2024-12-01-preview"

    # ── Proofgrove agent target (kagent) ──────────────────────────────────────
    # kagent controller REST + A2A endpoint. Used to (a) list tenant agents
    # (GET /api/agents, mirrors evalai-agent-ui) and (b) invoke an agent over
    # A2A (POST /api/a2a/<ns>/<name>/ message/stream, mirrors workflow-worker).
    # The in-cluster gateway is keyless. Default matches the operator-stamped
    # value (kagent lives in evalai-platform).
    kagent_url: str = "http://kagent-controller.evalai-platform.svc.cluster.local:8083"
    # Secret-injected JSON: connection name -> origin + Authorization/x-api-key.
    # Catalog records store only the connection name, never the header values.
    external_agent_credentials: dict[str, dict[str, SecretStr]] = Field(default_factory=dict)
    # Tenant namespace this proofgrove runs in (downward API POD_NAMESPACE). Scopes
    # agent discovery and is the namespace segment of the A2A URL. Empty outside
    # a cluster (tests / local `uv run`).
    pod_namespace: str = ""
    # Outbound knobs for the agent runner (mirror workflow-worker). The byte cap
    # bounds the entire A2A/SSE stream (status deltas + tool results + final
    # answer) so a runaway agent cannot exhaust memory. Prefer artifacting large
    # tool results over raising this cap; oversized streams fail the row as
    # AGENT_OUTPUT_TOO_LARGE and the experiment continues.
    agent_invocation_timeout_seconds: float = 300.0
    agent_connect_timeout_seconds: float = 30.0
    agent_response_max_bytes: int = 8_388_608
    # A single SSE event may contain a JSON tool result. Keep this transport
    # envelope separate from the smaller evaluator-facing inline budget.
    agent_response_max_event_bytes: int = 5_242_880
    agent_max_inline_tool_result_bytes: int = 131_072
    artifact_page_max_bytes: int = 131_072
    # The current sessions endpoint exposes observed events but cannot attest
    # that persistence has settled or that an empty event list is complete.
    # Tool-scope scoring uses the OTEL archive instead when
    # ``trace_archive_enabled`` is true (Phoenix / Confident AI).
    tool_evidence_completion_manifest_available: bool = False

    # ── Dataset generation ─────────────────────────────────────────────────
    # In-process generation tasks (proofgrove.datasets.generation_service) run
    # unbounded by default — every POST /datasets/generate spawns its own
    # asyncio task with no limit on how many run their synthesis
    # concurrently. This bounds it so a burst of requests cannot open
    # unbounded concurrent calls to the generation LLM/gateway.
    dataset_generation_max_concurrent_jobs: int = 5
    # `_synthesize_records` is one long await with no natural progress
    # checkpoint, so without a periodic touch of `updated_at` a job still
    # actively generating for longer than `_INTERRUPTED_STALE_AFTER_SECONDS`
    # (900s, generation_jobs.py) looks abandoned to `mark_interrupted`'s
    # process-restart sweep — a sibling replica starting up mid-generation
    # would fail a live job out from under it. Must stay well under 900s.
    dataset_generation_progress_heartbeat_seconds: float = 60.0

    # Archived OTLP trace evidence. Proofgrove has read-only object-store access;
    # RabbitMQ credentials remain owned solely by the collector and archive sink.
    # accessKey = MinIO/S3 static keys; workloadIdentity = Azure Blob + DefaultAzureCredential.
    # Profile overlay (configs/app_config.py): "default" = RabbitMQ + MinIO,
    # "azure" = Service Bus + Blob. APP_CONFIG_PROFILE is the platform-wide
    # alias; TRACE_ARCHIVE_PROFILE wins when both are set. A non-default
    # profile stamps auth_mode/force_path_style; "default" keeps explicit
    # operator overrides intact.
    trace_archive_profile: str = ""
    app_config_profile: str = ""
    trace_archive_enabled: bool = False
    trace_archive_auth_mode: str = "accessKey"
    trace_archive_endpoint: str = ""
    trace_archive_region: str = "us-east-1"
    trace_archive_access_key: SecretStr = SecretStr("")
    trace_archive_secret_key: SecretStr = SecretStr("")
    trace_archive_bucket: str = "proofgrove-traces"
    trace_archive_prefix: str = "traces"
    trace_archive_environment: str = "local"
    trace_archive_force_path_style: bool = True
    # Per-call connect/read timeout for the object-store client (S3 or Azure
    # Blob). Without this, a hung backend can block the hydrator's worker
    # thread indefinitely -- well past trace_archive_score_timeout_seconds --
    # since that deadline is only checked between polls, not inside a single
    # blocking object-store call.
    trace_archive_client_timeout_seconds: float = 10.0
    trace_archive_max_objects: int = 500
    trace_archive_max_object_bytes: int = 67_108_864
    # Retained for deployment compatibility. Evaluation no longer truncates a
    # trace at this count; it paginates object listings and filters the complete
    # trace to TOOL/AGENT spans plus their required parents.
    # Fast-path wait after invoke for collector → queue → Parquet export.
    # Phoenix / Confident AI score a completed trajectory (root closed, children
    # finalized). The default is Phoenix-style non-blocking completion: after
    # this bounded wait, response metrics score from the captured response while
    # tool metrics abstain unless the archive attested a complete trajectory.
    # The invoked-row snapshot remains parked privately for late enrichment;
    # the public run itself is terminal after this bounded wait.
    trace_archive_score_poll_seconds: float = 2.0
    # Once a completion marker is visible, require the same fully paginated
    # object/span snapshot to remain unchanged for this interval. This replaces
    # the collector's coarse 30-second grouping delay with a small,
    # completion-aware barrier for asynchronously exported child spans.
    trace_archive_completion_settle_seconds: float = 10.0
    # A timer alone can be fooled by a long or jittery poll. Require multiple
    # matching archive reads as independent confirmation of quiescence.
    trace_archive_completion_min_identical_observations: int = 3
    # Customer-facing deadline for the initial complete-trajectory fast path.
    # Response-safe metrics are persisted when it expires; this is not the
    # much longer background enrichment window below.
    trace_archive_score_timeout_seconds: float = 60.0
    trace_archive_score_fallback_to_capture: bool = True
    # Retain the invoked-row snapshot for background telemetry enrichment after
    # the public partial result is complete. This no longer blocks the run UI.
    trace_archive_deferred_score: bool = True
    trace_archive_score_grace_seconds: float = 3600.0
    trace_archive_late_enrichment_seconds: float = 86_400.0
    trace_archive_deferred_poll_seconds: float = 15.0

    # ── Captured-trace index (collector-confirmed trace catalog) ──────────
    # A lifespan worker periodically (a) upserts index rows for evaluation run
    # items carrying genuine trace ids, (b) confirms them against the S3 trace
    # archive (recording span statistics), and (c) discovers non-evaluation
    # production traces from the archive's trace-index/ pointer prefix. All
    # limits are per tick so archive access stays bounded.
    trace_index_enabled: bool = False
    trace_index_interval_seconds: float = 60.0
    trace_index_upsert_batch_size: int = 500
    trace_index_confirm_batch_size: int = 25
    trace_index_discovery_max_traces: int = 200
    # A row that was checked and found empty stays `pending_export`; once it is
    # older than this grace window it is no longer re-checked every tick (export
    # pipelines that have not landed spans by then are not going to).
    trace_index_pending_grace_seconds: float = 3600.0
    # Bounded span summaries stored per confirmed trace (summary rows only —
    # span payloads stay in the archive).
    trace_index_max_spans_per_trace: int = 200

    # Platform tools attached to every Proofgrove agent by the tenant-operator (the
    # memory-mcp tools) are NOT under test — they are filtered out of the captured
    # tool-call trace so they never affect groundedness (tool_selection) or feed
    # faithfulness context. Matches memoryMcpToolNames() in the tenant-operator.
    excluded_tool_names: list[str] = [
        "memory_context",
        "memory_search",
        "memory_lookup",
        "memory_relationships",
        "memory_propose",
        "memory_promote",
    ]

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }

    @model_validator(mode="after")
    def _resolve_telemetry_profile(self) -> "Settings":
        name = self.trace_archive_profile or self.app_config_profile or "default"
        if name.strip().lower() == "default":
            # Keep explicit operator overrides (custom MinIO/S3 setups) intact.
            self.trace_archive_profile = "default"
        else:
            apply_telemetry_profile(self, name)

        # Kubernetes normally prevents the container from starting when a
        # required secretKeyRef is absent. Keep direct/container starts
        # fail-closed as well instead of accepting development credentials.
        if self.app_env.strip().lower() in {"prod", "production"}:
            if (
                not self.database_url.strip()
                or self.database_url.startswith("sqlite")
                or self.database_url == "postgresql+asyncpg://proofgrove:proofgrove@localhost:5432/proofgrove"
            ):
                raise ValueError(
                    "production requires DATABASE_URL from the proofgrove-postgres-credentials Secret"
                )

            if not self.platform_auth_required:
                raise ValueError("production requires PLATFORM_AUTH_REQUIRED=true")
            if not self.authz_check_token.get_secret_value().strip():
                raise ValueError(
                    "production requires AUTHZ_CHECK_TOKEN from the proofgrove authz Secret"
                )

            if self.trace_archive_enabled:
                if not self.trace_archive_endpoint.strip():
                    raise ValueError(
                        "TRACE_ARCHIVE_ENDPOINT is required when the trace archive is enabled"
                    )
                if self.trace_archive_auth_mode == "accessKey" and (
                    not self.trace_archive_access_key.get_secret_value().strip()
                    or not self.trace_archive_secret_key.get_secret_value().strip()
                ):
                    raise ValueError(
                        "access-key trace archive requires TRACE_ARCHIVE_ACCESS_KEY and "
                        "TRACE_ARCHIVE_SECRET_KEY from the archive credential Secret"
                    )
        return self


settings = Settings()
