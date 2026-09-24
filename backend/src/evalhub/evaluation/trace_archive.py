"""Read tenant-scoped, trace-only Parquet evidence from object storage."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import quote

import boto3
from botocore.config import Config

from evalhub.evaluation.models import ArchivedTraceSpan, RunItemTraceEvidence
from evalhub.evaluation.parquet_traces import is_parquet, spans_from_parquet, tenant_allowed
from evalhub.platform.authz import namespace_for_tenant
from evalhub.settings import Settings
from evalhub.tracing.models import semantic_span_kind

_COMPLETION_ATTRIBUTES = frozenset(
    {
        "evalai.execution.complete",
        "evalai.trace.complete",
        "execution.complete",
        "execution.completed",
        "trace.complete",
        "trace.completed",
    }
)
_COMPLETION_EVENTS = frozenset(
    {
        "evalai.execution.complete",
        "evalai.trace.complete",
        "execution.complete",
        "execution.completed",
        "trace.complete",
        "trace.completed",
    }
)
_TOOL_OPERATIONS = frozenset({"execute_tool", "tool.call", "invoke_tool", "tools"})


def _telemetry_backend(settings: Settings) -> str:
    """Return the stable provenance name for the selected archive backend."""

    if (
        settings.trace_archive_auth_mode == "workloadIdentity"
        or settings.trace_archive_profile == "azure"
    ):
        return "azure_blob"
    return "minio"


def tenant_from_namespace(namespace: str) -> str:
    """Resolve authorized deployment aliases before removing the namespace prefix."""
    namespace = namespace_for_tenant(namespace)
    if namespace.startswith("tenant-") and len(namespace) > 7:
        return namespace[7:]
    return namespace or "platform"


def _key_is_within_prefix(key: object, prefix: str) -> bool:
    """Reject dot segments before HTTP clients can normalize them outside the prefix."""
    return (
        isinstance(key, str)
        and key.startswith(prefix)
        and all(segment not in (".", "..") for segment in key.split("/"))
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


def _duration_ms(span: dict[str, Any]) -> float | None:
    try:
        return max(0, int(span["endTimeUnixNano"]) - int(span["startTimeUnixNano"])) / 1_000_000
    except (KeyError, TypeError, ValueError):
        return None


def _sort_key_nano(value: str | None) -> int:
    """Ordering-only parse: an unparseable timestamp sorts as 0 (deterministic degrade)."""
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def spans_for_trace(payload: object, trace_id: str, tenant: str) -> list[ArchivedTraceSpan]:
    if not isinstance(payload, dict) or not isinstance(payload.get("resourceSpans"), list):
        return []
    matches: list[ArchivedTraceSpan] = []
    for resource_span in payload["resourceSpans"]:
        if not isinstance(resource_span, dict):
            continue
        resource = resource_span.get("resource")
        resource_attributes = _attributes(resource.get("attributes") if isinstance(resource, dict) else None)
        if not tenant_allowed(resource_attributes, tenant):
            continue
        for scope_spans in resource_span.get("scopeSpans", []):
            if not isinstance(scope_spans, dict):
                continue
            for span in scope_spans.get("spans", []):
                if not isinstance(span, dict) or str(span.get("traceId", "")).lower() != trace_id.lower():
                    continue
                matches.append(
                    ArchivedTraceSpan(
                        trace_id=trace_id,
                        span_id=str(span.get("spanId", "")),
                        parent_span_id=str(span["parentSpanId"]) if span.get("parentSpanId") else None,
                        name=str(span.get("name", "unnamed span")),
                        kind=span.get("kind") if isinstance(span.get("kind"), int) else None,
                        start_time_unix_nano=str(span["startTimeUnixNano"]) if span.get("startTimeUnixNano") is not None else None,
                        end_time_unix_nano=str(span["endTimeUnixNano"]) if span.get("endTimeUnixNano") is not None else None,
                        duration_ms=_duration_ms(span),
                        status=span.get("status") if isinstance(span.get("status"), dict) else None,
                        attributes=_attributes(span.get("attributes")),
                        resource_attributes=resource_attributes,
                        events=span.get("events", []) if isinstance(span.get("events"), list) else [],
                    )
                )
    return matches


class AzureBlobS3Adapter:
    """Present Azure Blob list/get as the boto3 subset TraceArchiveReader uses."""

    # Class-level fallback so a test double built via __new__ (bypassing
    # __init__) still has a sane, bounded timeout instead of raising.
    _timeout: float = 10.0

    def __init__(self, account_url: str, container: str, *, timeout_seconds: float = 10.0) -> None:
        from azure.identity import DefaultAzureCredential
        from azure.storage.blob import BlobServiceClient

        self._timeout = timeout_seconds
        credential = DefaultAzureCredential(exclude_interactive_browser_credential=True)
        service = BlobServiceClient(
            account_url=account_url.rstrip("/"),
            credential=credential,
            connection_timeout=timeout_seconds,
            read_timeout=timeout_seconds,
        )
        self._container = service.get_container_client(container)

    def list_objects_v2(self, **kwargs: Any) -> dict[str, Any]:
        prefix = kwargs.get("Prefix", "")
        max_keys = int(kwargs.get("MaxKeys") or 1000)
        from azure.storage.blob import BlobPrefix

        options = {"name_starts_with": prefix, "results_per_page": max_keys, "timeout": self._timeout}
        if delimiter := kwargs.get("Delimiter"):
            listing = self._container.walk_blobs(delimiter=delimiter, **options)
        else:
            listing = self._container.list_blobs(**options)
        pager = listing.by_page(continuation_token=kwargs.get("ContinuationToken"))
        blobs = list(next(pager, []))
        continuation_token = pager.continuation_token
        return {
            "Contents": [{"Key": blob.name, "Size": blob.size} for blob in blobs if not isinstance(blob, BlobPrefix)],
            "CommonPrefixes": [{"Prefix": blob.name} for blob in blobs if isinstance(blob, BlobPrefix)],
            "IsTruncated": bool(continuation_token),
            "NextContinuationToken": continuation_token,
        }

    def get_object(self, **kwargs: Any) -> dict[str, Any]:
        key = kwargs["Key"]
        start, end = kwargs["Range"].removeprefix("bytes=").split("-", 1)
        downloader = self._container.get_blob_client(key).download_blob(
            offset=int(start), length=int(end) - int(start) + 1, timeout=self._timeout,
        )
        return {"Body": downloader}


class TraceArchiveReader:
    """Bounded object-store reader; credentials must be object-prefix read-only."""

    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self.settings = settings
        self.client = client

    async def find(
        self,
        *,
        trace_id: str | None,
        tenant: str,
        started_at: datetime | None,
        completed_at: datetime | None,
        relevant_only: bool = False,
    ) -> RunItemTraceEvidence:
        if not self.settings.trace_archive_enabled:
            return RunItemTraceEvidence(state="not_configured", trace_id=trace_id, message="Trace archive access is not enabled.")
        if not trace_id:
            return RunItemTraceEvidence(state="not_found", message="This evaluation item has no correlated trace ID.")
        return await asyncio.to_thread(
            self._find_sync,
            trace_id,
            tenant,
            started_at,
            completed_at,
            relevant_only,
        )

    def _list_objects(
        self,
        *,
        prefix: str,
        remaining: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        """Exhaust one object listing, or report that the safety bound stopped it."""

        items: list[dict[str, Any]] = []
        continuation_token: str | None = None
        while remaining > 0:
            kwargs: dict[str, Any] = {
                "Bucket": self.settings.trace_archive_bucket,
                "Prefix": prefix,
                "MaxKeys": min(1_000, remaining),
            }
            if continuation_token:
                kwargs["ContinuationToken"] = continuation_token
            response = self.client.list_objects_v2(**kwargs)
            page = [item for item in response.get("Contents", []) if isinstance(item, dict)]
            items.extend(page)
            remaining -= len(page)
            next_token = response.get("NextContinuationToken")
            is_truncated = bool(response.get("IsTruncated") or next_token)
            if not is_truncated:
                return items, True
            if not isinstance(next_token, str) or not next_token or next_token == continuation_token:
                return items, False
            continuation_token = next_token
        return items, False

    def _hour_prefixes(self, tenant: str, started_at: datetime | None, completed_at: datetime | None) -> list[str]:
        start = (started_at or datetime.now(UTC) - timedelta(hours=1)).astimezone(UTC).replace(minute=0, second=0, microsecond=0)
        end = (completed_at or datetime.now(UTC)).astimezone(UTC) + timedelta(hours=1)
        base = self.settings.trace_archive_prefix.strip("/")
        root = f"{base}/" if base else ""
        root += f"tenant={quote(tenant, safe='-_.')}/environment={self.settings.trace_archive_environment}/"
        prefixes: list[str] = []
        cursor = start
        while cursor <= end and len(prefixes) < 72:
            prefixes.append(f"{root}date={cursor:%Y-%m-%d}/hour={cursor:%H}/")
            cursor += timedelta(hours=1)
        return prefixes

    def _ensure_client(self) -> None:
        if self.client is not None:
            return
        timeout = self.settings.trace_archive_client_timeout_seconds
        if self.settings.trace_archive_auth_mode == "workloadIdentity":
            self.client = AzureBlobS3Adapter(
                self.settings.trace_archive_endpoint,
                self.settings.trace_archive_bucket,
                timeout_seconds=timeout,
            )
            return
        self.client = boto3.client(
            "s3",
            endpoint_url=self.settings.trace_archive_endpoint or None,
            region_name=self.settings.trace_archive_region,
            aws_access_key_id=self.settings.trace_archive_access_key.get_secret_value() or None,
            aws_secret_access_key=self.settings.trace_archive_secret_key.get_secret_value() or None,
            config=Config(
                connect_timeout=timeout,
                read_timeout=timeout,
                s3={
                    "addressing_style": (
                        "path" if self.settings.trace_archive_force_path_style else "virtual"
                    )
                },
            ),
        )

    def _find_sync(
        self,
        trace_id: str,
        tenant: str,
        started_at: datetime | None,
        completed_at: datetime | None,
        relevant_only: bool,
    ) -> RunItemTraceEvidence:
        self._ensure_client()
        telemetry_backend = _telemetry_backend(self.settings)
        keys: list[tuple[str, int]] = []
        base = self.settings.trace_archive_prefix.strip("/")
        tenant_root = f"{base}/" if base else ""
        tenant_root += f"tenant={quote(tenant, safe='-_.')}/environment={self.settings.trace_archive_environment}/"
        index_prefix = f"{tenant_root}trace-index/trace={trace_id.lower()}/"
        index_items, pagination_complete = self._list_objects(
            prefix=index_prefix,
            remaining=self.settings.trace_archive_max_objects,
        )
        read_complete = True
        for item in index_items:
            if not _key_is_within_prefix(item.get("Key"), index_prefix):
                read_complete = False
                continue
            pointer = self.client.get_object(
                Bucket=self.settings.trace_archive_bucket,
                Key=item["Key"],
                Range="bytes=0-16384",
            )["Body"].read(16_385)
            if len(pointer) > 16_384:
                read_complete = False
                continue
            try:
                object_key = json.loads(pointer).get("objectKey")
            except (AttributeError, UnicodeDecodeError, json.JSONDecodeError):
                read_complete = False
                continue
            # Defence in depth: never follow an index outside this tenant and
            # environment, even if an index object is malformed or compromised.
            if _key_is_within_prefix(object_key, tenant_root):
                keys.append((object_key, 0))
            else:
                read_complete = False

        # Compatibility for objects archived before trace-index-v1 existed.
        legacy_prefixes = [] if keys else self._hour_prefixes(tenant, started_at, completed_at)
        for prefix_index, prefix in enumerate(legacy_prefixes):
            items, page_complete = self._list_objects(
                prefix=prefix,
                remaining=max(0, self.settings.trace_archive_max_objects - len(keys)),
            )
            keys.extend(
                (item["Key"], int(item.get("Size", 0)))
                for item in items
                if isinstance(item, dict)
                and isinstance(item.get("Key"), str)
                and (item["Key"].endswith(".parquet") or item["Key"].endswith(".otel.json"))
            )
            pagination_complete = pagination_complete and page_complete
            if len(keys) >= self.settings.trace_archive_max_objects:
                if prefix_index < len(legacy_prefixes) - 1:
                    pagination_complete = False
                break

        spans: list[ArchivedTraceSpan] = []
        seen_span_ids: set[str] = set()
        object_refs: list[str] = []
        truncated = not pagination_complete or not read_complete
        for key, size in keys:
            if not _key_is_within_prefix(key, tenant_root) or (size and size > self.settings.trace_archive_max_object_bytes):
                truncated = True
                continue
            body = self.client.get_object(
                Bucket=self.settings.trace_archive_bucket,
                Key=key,
                Range=f"bytes=0-{self.settings.trace_archive_max_object_bytes}",
            )["Body"].read(self.settings.trace_archive_max_object_bytes + 1)
            retrieved_at = datetime.now(UTC)
            if len(body) > self.settings.trace_archive_max_object_bytes:
                truncated = True
                continue
            try:
                if is_parquet(body, key):
                    found = spans_from_parquet(body, trace_id, tenant)
                else:
                    found = spans_for_trace(json.loads(body), trace_id, tenant)
            except (UnicodeDecodeError, json.JSONDecodeError):
                truncated = True
                continue
            if found:
                object_refs.append(key)
                for span in found:
                    if span.span_id not in seen_span_ids:
                        seen_span_ids.add(span.span_id)
                        spans.append(
                            span.model_copy(
                                update={
                                    "telemetry_backend": telemetry_backend,
                                    "retrieved_at": retrieved_at,
                                }
                            )
                        )
            elif index_items:
                # An index pointer is an assertion that this object contains
                # the trace. Treat a missing match as lost/corrupt evidence.
                truncated = True
        spans.sort(key=lambda span: _sort_key_nano(span.start_time_unix_nano))
        if spans:
            lifecycle_complete = _trace_lifecycle_complete(spans)
            completion_diagnostic = (
                None if lifecycle_complete else _trace_completion_diagnostic(spans)
            )
            selected = _relevant_spans(spans) if relevant_only else spans
            evidence_complete = pagination_complete and lifecycle_complete and not truncated
            return RunItemTraceEvidence(
                state="available",
                trace_id=trace_id,
                spans=selected,
                object_refs=object_refs,
                pagination_complete=pagination_complete,
                lifecycle_complete=lifecycle_complete,
                evidence_complete=evidence_complete,
                truncated=truncated,
                completion_diagnostic=completion_diagnostic,
                message=(
                    None
                    if evidence_complete
                    else "Trace evidence is incomplete: archive pagination or trace lifecycle is unfinished."
                ),
            )
        return RunItemTraceEvidence(
            state="pending" if completed_at is None else "not_found",
            trace_id=trace_id,
            pagination_complete=pagination_complete,
            truncated=truncated,
            message="Trace export may still be in flight." if completed_at is None else "No archived spans matched this trace ID.",
        )


def _truthy(value: object) -> bool:
    if value is True or value == 1:
        return True
    return isinstance(value, str) and value.strip().lower() in {"1", "true", "yes", "complete", "completed"}


def _has_completion_marker(span: ArchivedTraceSpan) -> bool:
    if any(_truthy((span.attributes or {}).get(key)) for key in _COMPLETION_ATTRIBUTES):
        return True
    for event in span.events:
        if isinstance(event, dict) and str(event.get("name") or "").strip().lower() in _COMPLETION_EVENTS:
            return True
    return False


def _trace_lifecycle_complete(spans: list[ArchivedTraceSpan]) -> bool:
    """Completeness is attested, never inferred.

    The previous fallback treated "some parentless span has ended" as proof
    that the whole trace landed. It cannot be: a captured child whose parent
    was never exported is indistinguishable from a genuine root, and a root
    finishing says nothing about sibling subtrees still in flight. Measured
    against the live archive the fallback attested every single-span transport
    trace as complete, while every real agent trace -- which arrives without
    its root span -- came back incomplete. The signal was strongest exactly
    where it was worth least.

    Only an explicit completion marker attests completeness. Without one the
    caller reports partial/unknown capture instead of manufacturing a
    guarantee no component has made.
    """

    return any(
        not span.parent_span_id and _has_completion_marker(span) for span in spans
    )


def _trace_completion_diagnostic(spans: list[ArchivedTraceSpan]) -> str:
    """Explain the missing lifecycle attestation without guessing completeness."""

    if not any(not span.parent_span_id for span in spans):
        return "root_span_missing"
    return "completion_marker_missing"


def _is_relevant_span(span: ArchivedTraceSpan) -> bool:
    """Keep the spans that did semantic work, by what they recorded.

    ``span_kind_label`` answers with the OTLP transport kind — server, internal,
    client — and never tool/agent/llm, so a kind check against those could not
    match a real span. Measured on the archive: a 77-span agent trace returned
    **zero** relevant spans, which is what the scoring path reads. Tool evidence
    extraction therefore saw nothing and the trace looked uncaptured. The span
    index already classifies from recorded attributes; this now uses the same
    classifier so the two cannot disagree about what a span is.
    """

    kind = semantic_span_kind(span) or ""
    if kind in {"tool", "agent", "llm", "retriever"}:
        return True
    attrs = span.attributes or {}
    if attrs.get("gen_ai.tool.name") or attrs.get("tool.name"):
        return True
    operation = str(attrs.get("gen_ai.operation.name") or "").strip().lower()
    return operation in _TOOL_OPERATIONS


def _relevant_spans(spans: list[ArchivedTraceSpan]) -> list[ArchivedTraceSpan]:
    """Keep scoring spans, roots, and the complete ancestor chain they need."""

    by_id = {span.span_id: span for span in spans if span.span_id}
    keep = {span.span_id for span in spans if _is_relevant_span(span) or not span.parent_span_id}
    pending = list(keep)
    while pending:
        span = by_id.get(pending.pop())
        parent_id = span.parent_span_id if span else None
        if parent_id and parent_id not in keep and parent_id in by_id:
            keep.add(parent_id)
            pending.append(parent_id)
    return [span for span in spans if span.span_id in keep]
