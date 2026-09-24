import io
import json
from datetime import UTC, datetime
from io import BytesIO
from typing import Any
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from evalhub.evaluation import trace_archive as trace_archive_module
from evalhub.evaluation.parquet_traces import spans_from_parquet
from evalhub.evaluation.trace_archive import (
    TraceArchiveReader,
    spans_for_trace,
    tenant_from_namespace,
)
from evalhub.settings import Settings

TRACE_ID = "0123456789abcdef0123456789abcdef"


@pytest.mark.parametrize("source", ["index", "pointer", "legacy"])
@pytest.mark.parametrize("suffix", [
    "./batch.otel.json",
    "../../tenant=victim/environment=local/batch.otel.json",
    "../../../../other-container/batch.otel.json",
])
def test_reader_rejects_dot_segments_before_any_object_download(source, suffix):
    root = "traces/tenant=evalai/environment=local/"
    pointer_key = f"{root}trace-index/trace={TRACE_ID}/pointer.json"
    downloads = []

    class UnsafeKeys:
        def list_objects_v2(self, **kwargs):
            prefix = kwargs["Prefix"]
            if "trace-index/" in prefix:
                if source == "legacy":
                    return {"Contents": []}
                key = f"{prefix}{suffix}" if source == "index" else pointer_key
                return {"Contents": [{"Key": key}]}
            return {"Contents": [{"Key": f"{prefix}{suffix}"}]} if source == "legacy" else {"Contents": []}

        def get_object(self, **kwargs):
            key = kwargs["Key"]
            downloads.append(key)
            payload = {"objectKey": f"{root}{suffix}"} if key == pointer_key else {"resourceSpans": []}
            return {"Body": BytesIO(json.dumps(payload).encode())}

    result = TraceArchiveReader(
        Settings(trace_archive_enabled=True, trace_archive_environment="local"),
        client=UnsafeKeys(),
    )._find_sync(TRACE_ID, "evalai", None, None, False)

    assert downloads == ([pointer_key] if source == "pointer" else [])
    assert result.truncated is True
    assert result.evidence_complete is False


def otlp_payload(*, namespace: str = "tenant-evalai", spans: list[dict] | None = None) -> dict:
    archived_spans = spans or [
        {
            "traceId": TRACE_ID,
            "spanId": "0123456789abcdef",
            "name": "agent.invoke",
            "startTimeUnixNano": "1000000",
            "endTimeUnixNano": "3500000",
            "attributes": [
                {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}}
            ],
            "status": {"code": 1},
        }
    ]
    return {
        "resourceSpans": [
            {
                "resource": {
                    "attributes": [
                        {"key": "k8s.namespace.name", "value": {"stringValue": namespace}},
                        {"key": "service.name", "value": {"stringValue": "agent"}},
                    ]
                },
                "scopeSpans": [
                    {
                        "spans": archived_spans
                    }
                ],
            }
        ]
    }


def test_extracts_only_matching_tenant_and_trace() -> None:
    spans = spans_for_trace(otlp_payload(), TRACE_ID, "evalai")
    assert len(spans) == 1
    assert spans[0].name == "agent.invoke"
    assert spans[0].duration_ms == 2.5
    assert spans[0].attributes == {"gen_ai.operation.name": "chat"}
    assert spans_for_trace(otlp_payload(namespace="tenant-acme"), TRACE_ID, "evalai") == []
    assert tenant_from_namespace("tenant-evalai") == "evalai"


# R4 — the read's final span.sort() key must not raise on a producer-mangled
# start_time_unix_nano (e.g. a float-serialising exporter's "1.7579e+18", or
# outright garbage). Ordering only, so a parse failure degrading to 0 is fine.
def test_sort_key_nano_falls_back_to_zero_for_unparseable_timestamps() -> None:
    assert trace_archive_module._sort_key_nano("1.7579e+18") == 0
    assert trace_archive_module._sort_key_nano("garbage") == 0
    assert trace_archive_module._sort_key_nano(None) == 0
    assert trace_archive_module._sort_key_nano("1000000") == 1000000


def test_parquet_round_trip_preserves_span_fields() -> None:
    spans = spans_from_parquet(encode_otlp_payload(otlp_payload()), TRACE_ID, "evalai")
    assert len(spans) == 1
    assert spans[0].name == "agent.invoke"
    assert spans[0].duration_ms == 2.5
    assert spans[0].attributes == {"gen_ai.operation.name": "chat"}
    assert spans_from_parquet(encode_otlp_payload(otlp_payload()), TRACE_ID, "acme") == []


def test_a_span_with_no_tenant_attribution_at_all_is_rejected_not_accepted() -> None:
    """Unowned evidence belongs to no one: a span whose resource carries
    neither ctx.tenant/ctx.customer_org nor a tenant-<x> k8s namespace must
    never be returned for any tenant's lookup, not even by accident."""

    unattributed = otlp_payload(namespace="observability")
    assert spans_for_trace(unattributed, TRACE_ID, "evalai") == []
    assert spans_for_trace(unattributed, TRACE_ID, "acme") == []
    assert spans_from_parquet(encode_otlp_payload(unattributed), TRACE_ID, "evalai") == []
    assert spans_from_parquet(encode_otlp_payload(unattributed), TRACE_ID, "acme") == []


class FakeS3:
    def __init__(self, body: bytes) -> None:
        self.body = body
        self.prefixes: list[str] = []

    def list_objects_v2(self, **kwargs):
        self.prefixes.append(kwargs["Prefix"])
        if "trace-index" in kwargs["Prefix"]:
            return {"Contents": []}
        return {"Contents": [{"Key": f"{kwargs['Prefix']}batch-x.parquet", "Size": len(self.body)}]}

    def get_object(self, **kwargs):
        return {"Body": io.BytesIO(self.body)}


@pytest.mark.asyncio
async def test_reader_lists_only_tenant_time_partitions_and_returns_spans() -> None:
    client = FakeS3(encode_otlp_payload(otlp_payload()))
    config = Settings(
        trace_archive_enabled=True,
        trace_archive_environment="local",
        trace_archive_max_objects=10,
    )
    result = await TraceArchiveReader(config, client=client).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=datetime(2026, 8, 21, 10, 10, tzinfo=UTC),
        completed_at=datetime(2026, 8, 21, 10, 11, tzinfo=UTC),
    )
    assert result.state == "available"
    assert len(result.spans) == 1
    assert result.spans[0].telemetry_backend == "minio"
    assert result.spans[0].retrieved_at is not None
    assert result.spans[0].retrieved_at.tzinfo is not None
    serialized = result.spans[0].model_dump(mode="json")
    assert serialized["telemetry_backend"] == "minio"
    assert serialized["retrieved_at"].endswith("Z")
    assert client.prefixes
    assert all("tenant=evalai/environment=local/" in prefix for prefix in client.prefixes)


@pytest.mark.asyncio
async def test_reader_records_azure_blob_provenance_on_every_span() -> None:
    client = FakeS3(encode_otlp_payload(otlp_payload()))
    result = await TraceArchiveReader(
        Settings(
            trace_archive_enabled=True,
            trace_archive_profile="azure",
            trace_archive_environment="violet",
            trace_archive_max_objects=10,
        ),
        client=client,
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=datetime(2026, 8, 21, 10, 10, tzinfo=UTC),
        completed_at=datetime(2026, 8, 21, 10, 11, tzinfo=UTC),
    )

    assert result.state == "available"
    assert result.spans
    assert all(span.telemetry_backend == "azure_blob" for span in result.spans)
    assert all(span.retrieved_at is not None for span in result.spans)


def test_ensure_client_configures_an_explicit_connect_and_read_timeout() -> None:
    """A hung MinIO/S3 endpoint must not block a single object-store call
    past the settings-configured timeout -- the hydrator's own polling
    deadline only gets a chance to run between calls, not inside one."""

    captured: dict[str, Any] = {}

    def fake_boto3_client(_service, **kwargs):
        captured.update(kwargs)
        return object()

    with patch.object(trace_archive_module.boto3, "client", fake_boto3_client):
        reader = TraceArchiveReader(
            Settings(trace_archive_enabled=True, trace_archive_client_timeout_seconds=3.5)
        )
        reader._ensure_client()

    config = captured["config"]
    assert config.connect_timeout == 3.5
    assert config.read_timeout == 3.5


def test_ensure_client_configures_an_explicit_timeout_for_azure_workload_identity() -> None:
    captured: dict[str, Any] = {}

    class FakeAzureAdapter:
        def __init__(self, account_url, container, *, timeout_seconds):
            captured["account_url"] = account_url
            captured["container"] = container
            captured["timeout_seconds"] = timeout_seconds

    with patch.object(trace_archive_module, "AzureBlobS3Adapter", FakeAzureAdapter):
        reader = TraceArchiveReader(
            Settings(
                trace_archive_enabled=True,
                trace_archive_auth_mode="workloadIdentity",
                trace_archive_client_timeout_seconds=7.0,
                trace_archive_endpoint="https://storage.example",
                trace_archive_bucket="traces",
            )
        )
        reader._ensure_client()

    assert captured["timeout_seconds"] == 7.0


@pytest.mark.asyncio
async def test_reader_propagates_promptly_when_the_backend_is_unavailable() -> None:
    """An unreachable archive backend must surface as a clean, immediate
    failure -- never hang, and never be silently misread as an empty or
    available result. Callers (e.g. the trace-index worker's
    ``_confirm_one``) rely on exactly this exception to mark the trace
    ``archive_unavailable`` and move on rather than stalling the tick."""

    class UnavailableS3:
        def list_objects_v2(self, **kwargs):
            raise ConnectionError("simulated: archive backend unreachable")

    with pytest.raises(ConnectionError, match="unreachable"):
        await TraceArchiveReader(
            Settings(trace_archive_enabled=True, trace_archive_environment="local"),
            client=UnavailableS3(),
        ).find(
            trace_id=TRACE_ID,
            tenant="evalai",
            started_at=None,
            completed_at=None,
        )


@pytest.mark.asyncio
async def test_reader_does_not_fall_back_to_another_tenant_partition() -> None:
    batch_key = "traces/tenant=platform/environment=local/date=2026-08-21/hour=10/batch-x.parquet"
    batch = encode_otlp_payload(otlp_payload(namespace="observability"))

    class PlatformOnlyS3:
        def __init__(self) -> None:
            self.prefixes: list[str] = []

        def list_objects_v2(self, **kwargs):
            prefix = kwargs["Prefix"]
            self.prefixes.append(prefix)
            if "tenant=platform/" in prefix and "trace-index" in prefix:
                return {"Contents": [{"Key": f"{prefix}batch-x.json", "Size": 50}]}
            return {"Contents": []}

        def get_object(self, **kwargs):
            if "trace-index" in kwargs["Key"]:
                return {"Body": io.BytesIO(json.dumps({"objectKey": batch_key}).encode())}
            return {"Body": io.BytesIO(batch)}

    client = PlatformOnlyS3()
    result = await TraceArchiveReader(
        Settings(trace_archive_enabled=True, trace_archive_environment="local"),
        client=client,
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        completed_at=None,
    )
    assert result.state == "pending"
    assert not result.spans
    assert client.prefixes
    assert all("tenant=evalai/" in prefix for prefix in client.prefixes)


@pytest.mark.asyncio
async def test_reader_uses_direct_trace_index_without_hourly_scan() -> None:
    batch_key = "traces/tenant=evalai/environment=local/date=2026-08-21/hour=10/batch-x.parquet"
    batch = encode_otlp_payload(otlp_payload())

    class IndexedS3:
        def __init__(self) -> None:
            self.prefixes: list[str] = []

        def list_objects_v2(self, **kwargs):
            self.prefixes.append(kwargs["Prefix"])
            return {"Contents": [{"Key": f"{kwargs['Prefix']}batch-x.json", "Size": 50}]}

        def get_object(self, **kwargs):
            if "trace-index" in kwargs["Key"]:
                return {"Body": io.BytesIO(json.dumps({"objectKey": batch_key}).encode())}
            return {"Body": io.BytesIO(batch)}

    client = IndexedS3()
    result = await TraceArchiveReader(
        Settings(trace_archive_enabled=True, trace_archive_environment="local"),
        client=client,
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        completed_at=None,
    )
    assert result.state == "available"
    assert client.prefixes == [
        f"traces/tenant=evalai/environment=local/trace-index/trace={TRACE_ID}/"
    ]


@pytest.mark.asyncio
async def test_reader_parses_legacy_otlp_json_objects() -> None:
    payload = json.dumps(otlp_payload()).encode()

    class LegacyS3:
        def list_objects_v2(self, **kwargs):
            return {
                "Contents": [
                    {
                        "Key": f"{kwargs['Prefix']}batch-x.otel.json",
                        "Size": len(payload),
                    }
                ]
            }

        def get_object(self, **kwargs):
            return {"Body": io.BytesIO(payload)}

    result = await TraceArchiveReader(
        Settings(
            trace_archive_enabled=True,
            trace_archive_environment="local",
            trace_archive_max_objects=10,
        ),
        client=LegacyS3(),
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=datetime(2026, 8, 21, 10, 10, tzinfo=UTC),
        completed_at=datetime(2026, 8, 21, 10, 11, tzinfo=UTC),
    )
    assert result.state == "available"
    assert result.spans[0].name == "agent.invoke"


@pytest.mark.asyncio
async def test_reader_follows_trace_index_pagination_and_filters_to_required_spans() -> None:
    root = {
        "traceId": TRACE_ID,
        "spanId": "root",
        "name": "agent",
        "startTimeUnixNano": "1",
        "endTimeUnixNano": "100",
        "attributes": [
            {"key": "openinference.span.kind", "value": {"stringValue": "AGENT"}},
            {"key": "evalai.trace.complete", "value": {"boolValue": True}},
        ],
    }
    intermediary = {
        "traceId": TRACE_ID,
        "spanId": "chain",
        "parentSpanId": "root",
        "name": "required parent",
        "startTimeUnixNano": "2",
        "endTimeUnixNano": "90",
    }
    tool = {
        "traceId": TRACE_ID,
        "spanId": "tool",
        "parentSpanId": "chain",
        "name": "lookup",
        "startTimeUnixNano": "3",
        "endTimeUnixNano": "4",
        "attributes": [
            {"key": "openinference.span.kind", "value": {"stringValue": "TOOL"}}
        ],
    }
    unrelated = {
        "traceId": TRACE_ID,
        "spanId": "retriever",
        "parentSpanId": "root",
        "name": "not required",
        "startTimeUnixNano": "5",
        "endTimeUnixNano": "6",
        "attributes": [
            {"key": "openinference.span.kind", "value": {"stringValue": "RETRIEVER"}}
        ],
    }
    batches = {
        "batch-1.parquet": encode_otlp_payload(otlp_payload(spans=[root, intermediary])),
        "batch-2.parquet": encode_otlp_payload(otlp_payload(spans=[tool, unrelated])),
    }

    class PaginatedS3:
        def __init__(self) -> None:
            self.tokens: list[str | None] = []

        def list_objects_v2(self, **kwargs):
            self.tokens.append(kwargs.get("ContinuationToken"))
            if kwargs.get("ContinuationToken") is None:
                return {
                    "Contents": [{"Key": f"{kwargs['Prefix']}pointer-1.json"}],
                    "IsTruncated": True,
                    "NextContinuationToken": "page-2",
                }
            return {"Contents": [{"Key": f"{kwargs['Prefix']}pointer-2.json"}]}

        def get_object(self, **kwargs):
            key = kwargs["Key"]
            if key.endswith("pointer-1.json"):
                body = json.dumps(
                    {
                        "objectKey": (
                            "traces/tenant=evalai/environment=local/date=2026-08-21/"
                            "hour=10/batch-1.parquet"
                        )
                    }
                ).encode()
            elif key.endswith("pointer-2.json"):
                body = json.dumps(
                    {
                        "objectKey": (
                            "traces/tenant=evalai/environment=local/date=2026-08-21/"
                            "hour=10/batch-2.parquet"
                        )
                    }
                ).encode()
            else:
                body = batches[key.rsplit("/", 1)[-1]]
            return {"Body": io.BytesIO(body)}

    client = PaginatedS3()
    result = await TraceArchiveReader(
        Settings(
            trace_archive_enabled=True,
            trace_archive_environment="local",
            trace_archive_max_objects=10,
        ),
        client=client,
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        completed_at=None,
        relevant_only=True,
    )

    assert client.tokens == [None, "page-2"]
    assert [span.span_id for span in result.spans] == ["root", "chain", "tool", "retriever"]
    assert result.pagination_complete is True
    assert result.lifecycle_complete is True
    assert result.evidence_complete is True
    assert result.truncated is False


@pytest.mark.asyncio
async def test_reader_does_not_truncate_a_complete_trace_at_legacy_span_limit() -> None:
    root = {
        "traceId": TRACE_ID,
        "spanId": "root",
        "name": "agent",
        "startTimeUnixNano": "1",
        "endTimeUnixNano": "999999",
        "attributes": [
            {"key": "openinference.span.kind", "value": {"stringValue": "AGENT"}},
            {"key": "evalai.trace.complete", "value": {"boolValue": True}},
        ],
    }
    tools = [
        {
            "traceId": TRACE_ID,
            "spanId": f"tool-{index}",
            "parentSpanId": "root",
            "name": "tool",
            "startTimeUnixNano": str(index + 2),
            "endTimeUnixNano": str(index + 3),
            "attributes": [
                {"key": "openinference.span.kind", "value": {"stringValue": "TOOL"}}
            ],
        }
        for index in range(1_001)
    ]
    client = FakeS3(encode_otlp_payload(otlp_payload(spans=[root, *tools])))
    result = await TraceArchiveReader(
        Settings(
            trace_archive_enabled=True,
            trace_archive_environment="local",
            trace_archive_max_objects=10,
        ),
        client=client,
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=datetime(2026, 8, 21, 10, 10, tzinfo=UTC),
        completed_at=datetime(2026, 8, 21, 10, 11, tzinfo=UTC),
        relevant_only=True,
    )

    assert len(result.spans) == 1_002
    assert result.evidence_complete is True
    assert result.truncated is False


@pytest.mark.asyncio
async def test_an_ended_root_span_alone_does_not_attest_completeness() -> None:
    """A finished root proves the root finished, nothing about the rest.

    Measured on the live archive, the old root-span fallback attested every
    single-span transport trace as complete while every real agent trace --
    which reaches the archive without its root -- was reported incomplete.
    """

    lone_root = {
        "traceId": TRACE_ID,
        "spanId": "root",
        "name": "GET",
        "startTimeUnixNano": "1",
        "endTimeUnixNano": "100",
    }
    client = FakeS3(encode_otlp_payload(otlp_payload(spans=[lone_root])))
    result = await TraceArchiveReader(
        Settings(
            trace_archive_enabled=True,
            trace_archive_environment="local",
            trace_archive_max_objects=10,
        ),
        client=client,
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=datetime(2026, 8, 21, 10, 10, tzinfo=UTC),
        completed_at=datetime(2026, 8, 21, 10, 11, tzinfo=UTC),
    )

    assert result.state == "available"
    assert result.spans
    assert result.lifecycle_complete is False
    assert result.evidence_complete is False
    assert result.completion_diagnostic == "completion_marker_missing"


@pytest.mark.asyncio
async def test_missing_root_emits_precise_completion_diagnostic() -> None:
    child = {
        "traceId": TRACE_ID,
        "spanId": "agent-child",
        "parentSpanId": "missing-root",
        "name": "agent",
        "startTimeUnixNano": "1",
        "endTimeUnixNano": "100",
        "attributes": [
            {"key": "openinference.span.kind", "value": {"stringValue": "AGENT"}}
        ],
    }
    result = await TraceArchiveReader(
        Settings(trace_archive_enabled=True, trace_archive_environment="local"),
        client=FakeS3(encode_otlp_payload(otlp_payload(spans=[child]))),
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        completed_at=None,
    )

    assert result.pagination_complete is True
    assert result.evidence_complete is False
    assert result.completion_diagnostic == "root_span_missing"


@pytest.mark.asyncio
async def test_an_explicit_completion_marker_attests_completeness() -> None:
    marked = {
        "traceId": TRACE_ID,
        "spanId": "root",
        "name": "agent",
        "startTimeUnixNano": "1",
        "endTimeUnixNano": "100",
        "attributes": [
            {"key": "evalai.execution.complete", "value": {"stringValue": "true"}}
        ],
    }
    client = FakeS3(encode_otlp_payload(otlp_payload(spans=[marked])))
    result = await TraceArchiveReader(
        Settings(
            trace_archive_enabled=True,
            trace_archive_environment="local",
            trace_archive_max_objects=10,
        ),
        client=client,
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=datetime(2026, 8, 21, 10, 10, tzinfo=UTC),
        completed_at=datetime(2026, 8, 21, 10, 11, tzinfo=UTC),
    )

    assert result.lifecycle_complete is True
    assert result.evidence_complete is True
    assert result.completion_diagnostic is None


@pytest.mark.asyncio
async def test_a_child_completion_marker_does_not_attest_root_lifecycle() -> None:
    spans = [
        {
            "traceId": TRACE_ID,
            "spanId": "root",
            "name": "agent",
            "startTimeUnixNano": "1",
            "endTimeUnixNano": "100",
        },
        {
            "traceId": TRACE_ID,
            "spanId": "child",
            "parentSpanId": "root",
            "name": "tool",
            "startTimeUnixNano": "2",
            "endTimeUnixNano": "90",
            "attributes": [
                {
                    "key": "evalai.execution.complete",
                    "value": {"boolValue": True},
                }
            ],
        },
    ]
    result = await TraceArchiveReader(
        Settings(trace_archive_enabled=True, trace_archive_environment="local"),
        client=FakeS3(encode_otlp_payload(otlp_payload(spans=spans))),
    ).find(
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        completed_at=None,
    )

    assert result.lifecycle_complete is False
    assert result.evidence_complete is False
    assert result.completion_diagnostic == "completion_marker_missing"


SPAN_SCHEMA = pa.schema(
    [
        ("trace_id", pa.string()),
        ("span_id", pa.string()),
        ("parent_span_id", pa.string()),
        ("name", pa.string()),
        ("kind", pa.int32()),
        ("start_time_unix_nano", pa.string()),
        ("end_time_unix_nano", pa.string()),
        ("status_json", pa.string()),
        ("attributes_json", pa.string()),
        ("resource_attributes_json", pa.string()),
        ("events_json", pa.string()),
        ("scope_name", pa.string()),
    ]
)

def _any_value(value: object) -> Any:
    if not isinstance(value, dict):
        return None
    for key in ("stringValue", "intValue", "doubleValue", "boolValue", "bytesValue"):
        if key in value:
            return value[key]
    if isinstance(value.get("arrayValue"), dict):
        return [_any_value(item) for item in value["arrayValue"].get("values", [])]
    if isinstance(value.get("kvlistValue"), dict):
        return _attributes(value["kvlistValue"].get("values"))
    return None

def _attributes(values: object) -> dict[str, Any]:
    if not isinstance(values, list):
        return {}
    return {
        item["key"]: _any_value(item.get("value"))
        for item in values
        if isinstance(item, dict) and isinstance(item.get("key"), str)
    }

def _dumps(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)

def encode_otlp_payload(payload: dict[str, object]) -> bytes:
    """Encode OTLP/HTTP traces JSON as the sink's span-per-row Parquet layout."""

    rows: list[dict[str, object]] = []
    resource_spans = payload.get("resourceSpans")
    if isinstance(resource_spans, list):
        for resource_span in resource_spans:
            if not isinstance(resource_span, dict):
                continue
            resource = resource_span.get("resource")
            resource_attributes = _attributes(resource.get("attributes") if isinstance(resource, dict) else None)
            for scope_spans in resource_span.get("scopeSpans", []):
                if not isinstance(scope_spans, dict):
                    continue
                scope = scope_spans.get("scope")
                scope_name = None
                if isinstance(scope, dict) and isinstance(scope.get("name"), str):
                    scope_name = scope["name"]
                for span in scope_spans.get("spans", []):
                    if not isinstance(span, dict):
                        continue
                    status = span.get("status") if isinstance(span.get("status"), dict) else None
                    events = span.get("events") if isinstance(span.get("events"), list) else []
                    kind = span.get("kind")
                    rows.append(
                        {
                            "trace_id": str(span.get("traceId", "")).lower(),
                            "span_id": str(span.get("spanId", "")),
                            "parent_span_id": str(span["parentSpanId"]) if span.get("parentSpanId") else None,
                            "name": str(span.get("name", "unnamed span")),
                            "kind": kind if isinstance(kind, int) else None,
                            "start_time_unix_nano": (
                                str(span["startTimeUnixNano"]) if span.get("startTimeUnixNano") is not None else None
                            ),
                            "end_time_unix_nano": (
                                str(span["endTimeUnixNano"]) if span.get("endTimeUnixNano") is not None else None
                            ),
                            "status_json": _dumps(status) if status is not None else None,
                            "attributes_json": _dumps(_attributes(span.get("attributes"))),
                            "resource_attributes_json": _dumps(resource_attributes),
                            "events_json": _dumps(events),
                            "scope_name": scope_name,
                        }
                    )
    table = pa.Table.from_pylist(rows, schema=SPAN_SCHEMA)
    buffer = BytesIO()
    pq.write_table(
        table,
        buffer,
        compression="zstd",
        use_dictionary=False,
        write_statistics=False,
        store_schema=True,
        version="2.6",
    )
    return buffer.getvalue()


@pytest.mark.parametrize("oversized", [None, "pointer", "evidence"])
def test_azure_reader_bounds_pointer_and_evidence_downloads(oversized):
    from types import SimpleNamespace

    tenant_root = "traces/tenant=evalai/environment=local/"
    pointer_key = f"{tenant_root}trace-index/trace={TRACE_ID}/pointer.json"
    evidence_key = f"{tenant_root}batch.otel.json"
    payload = otlp_payload()
    payload["resourceSpans"][0]["scopeSpans"][0]["spans"][0]["attributes"].append(
        {"key": "evalai.execution.complete", "value": {"boolValue": True}}
    )
    bodies = {
        pointer_key: json.dumps({"objectKey": evidence_key}).encode(),
        evidence_key: json.dumps(payload).encode(),
    }
    limit = 2048
    if oversized == "pointer":
        bodies[pointer_key] += b" " * 20_000
    if oversized == "evidence":
        bodies[evidence_key] += b" " * limit
    downloads = []

    def blob(key):
        def download_blob(*, offset, length, timeout):
            downloads.append((key, offset, length))
            assert timeout == 10.0
            # A BytesIO exposes bounded read(), deliberately no readall().
            return BytesIO(bodies[key][offset:offset + length])
        return SimpleNamespace(download_blob=download_blob)

    adapter = trace_archive_module.AzureBlobS3Adapter.__new__(trace_archive_module.AzureBlobS3Adapter)
    adapter._container = SimpleNamespace(get_blob_client=blob)
    adapter.list_objects_v2 = lambda **kwargs: {
        "Contents": [{"Key": pointer_key}] if "trace-index/" in kwargs["Prefix"] else [],
    }
    reader = TraceArchiveReader(Settings(
        trace_archive_enabled=True, trace_archive_environment="local",
        trace_archive_max_object_bytes=limit,
    ), client=adapter)
    result = reader._find_sync(TRACE_ID, "evalai", None, None, False)
    assert downloads[0] == (pointer_key, 0, 16_385)
    if oversized == "pointer":
        assert len(downloads) == 1
    else:
        assert downloads[1] == (evidence_key, 0, limit + 1)
    assert result.truncated is (oversized is not None)
    assert result.evidence_complete is (oversized is None)
    assert bool(result.spans) is (oversized is None)
