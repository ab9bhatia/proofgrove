"""Decode span-per-row Parquet batches written by trace-archive-sink.

The column schema must stay aligned with
``services/proofgrove/trace-archive-sink/src/trace_archive_sink/parquet_traces.py``.
"""

from __future__ import annotations

import json
from io import BytesIO
from typing import Any


from proofgrove.evaluation.models import ArchivedTraceSpan

PARQUET_MAGIC = b"PAR1"


def is_parquet(body: bytes, key: str = "") -> bool:
    if key.endswith(".parquet") or key.endswith(".otel.parquet"):
        return True
    return body.startswith(PARQUET_MAGIC)










def _loads(value: object) -> Any:
    if not isinstance(value, str) or not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _duration_ms(start: str | None, end: str | None) -> float | None:
    try:
        return max(0, int(end or 0) - int(start or 0)) / 1_000_000
    except (TypeError, ValueError):
        return None


def tenant_allowed(resource_attributes: dict[str, Any], tenant: str) -> bool:
    """Return True only when ``resource_attributes`` unambiguously belong to ``tenant``.

    A span carrying no tenant attribution at all is rejected, not accepted --
    unowned evidence belongs to no one, and letting it through would leak
    another tenant's (or an un-attributed producer's) span into this read.
    """
    attributed_tenant = resource_attributes.get("ctx.tenant") or resource_attributes.get("ctx.customer_org")
    if attributed_tenant:
        return attributed_tenant == tenant
    namespace = resource_attributes.get("k8s.namespace.name")
    if isinstance(namespace, str) and namespace.startswith("tenant-"):
        return namespace[7:] == tenant
    return False


def spans_from_parquet(body: bytes, trace_id: str, tenant: str) -> list[ArchivedTraceSpan]:
    """Return spans in ``body`` that match ``trace_id`` and ``tenant``."""

    import pyarrow.parquet as pq

    try:
        table = pq.read_table(BytesIO(body))
    except (OSError, ValueError):
        return []
    wanted = trace_id.lower()
    matches: list[ArchivedTraceSpan] = []
    columns = {name: table.column(name) for name in table.column_names}

    def cell(name: str, index: int) -> Any:
        column = columns.get(name)
        if column is None:
            return None
        return column[index].as_py()

    for index in range(table.num_rows):
        row_trace_id = str(cell("trace_id", index) or "").lower()
        if row_trace_id != wanted:
            continue
        resource_attributes = _loads(cell("resource_attributes_json", index)) or {}
        if not isinstance(resource_attributes, dict) or not tenant_allowed(resource_attributes, tenant):
            continue
        start = cell("start_time_unix_nano", index)
        end = cell("end_time_unix_nano", index)
        start_s = str(start) if start is not None else None
        end_s = str(end) if end is not None else None
        kind = cell("kind", index)
        status = _loads(cell("status_json", index))
        attributes = _loads(cell("attributes_json", index))
        events = _loads(cell("events_json", index))
        parent = cell("parent_span_id", index)
        matches.append(
            ArchivedTraceSpan(
                trace_id=trace_id,
                span_id=str(cell("span_id", index) or ""),
                parent_span_id=str(parent) if parent else None,
                name=str(cell("name", index) or "unnamed span"),
                kind=kind if isinstance(kind, int) else None,
                start_time_unix_nano=start_s,
                end_time_unix_nano=end_s,
                duration_ms=_duration_ms(start_s, end_s),
                status=status if isinstance(status, dict) else None,
                attributes=attributes if isinstance(attributes, dict) else {},
                resource_attributes=resource_attributes,
                events=events if isinstance(events, list) else [],
            )
        )
    return matches
