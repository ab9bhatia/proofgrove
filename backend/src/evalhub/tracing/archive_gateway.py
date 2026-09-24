"""Read-only trace-archive access for the index worker.

Wraps the existing :class:`TraceArchiveReader` (per-trace pointer lookup) and
adds a bounded scan of the archive's ``trace-index/`` pointer prefix so
evaluation traces can be discovered. Credentials remain the
object-prefix read-only pair owned by the archive sink deployment.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from urllib.parse import quote

from evalhub.evaluation.models import RunItemTraceEvidence
from evalhub.evaluation.trace_archive import TraceArchiveReader
from evalhub.settings import Settings


class TraceArchiveGateway:
    """Bounded S3 access: per-trace confirmation + trace-id discovery."""

    def __init__(self, settings: Settings, client: object | None = None) -> None:
        self.settings = settings
        self.reader = TraceArchiveReader(settings, client=client)

    def _tenant_root(self, tenant: str) -> str:
        base = self.settings.trace_archive_prefix.strip("/")
        root = f"{base}/" if base else ""
        return root + (
            f"tenant={quote(tenant, safe='-_.')}/environment={self.settings.trace_archive_environment}/"
        )

    async def find(
        self,
        *,
        trace_id: str,
        tenant: str,
        started_at: datetime | None = None,
        completed_at: datetime | None = None,
    ) -> RunItemTraceEvidence:
        return await self.reader.find(
            trace_id=trace_id,
            tenant=tenant,
            started_at=started_at,
            completed_at=completed_at,
        )

    async def list_archived_trace_ids(self, tenant: str, *, limit: int) -> list[str]:
        """Trace ids present under this tenant's ``trace-index/`` prefix."""
        if not self.settings.trace_archive_enabled or limit <= 0:
            return []
        return await asyncio.to_thread(self._list_sync, tenant, limit)

    def _list_sync(self, tenant: str, limit: int) -> list[str]:
        self.reader._ensure_client()
        client = self.reader.client
        prefix = f"{self._tenant_root(tenant)}trace-index/"
        trace_ids: list[str] = []
        continuation: str | None = None
        while len(trace_ids) < limit:
            kwargs = {
                "Bucket": self.settings.trace_archive_bucket,
                "Prefix": prefix,
                "Delimiter": "/",
                "MaxKeys": min(1000, limit - len(trace_ids)),
            }
            if continuation:
                kwargs["ContinuationToken"] = continuation
            response = client.list_objects_v2(**kwargs)
            for entry in response.get("CommonPrefixes", []):
                value = entry.get("Prefix") if isinstance(entry, dict) else None
                if not isinstance(value, str):
                    continue
                segment = value[len(prefix) :].strip("/")
                if segment.startswith("trace=") and len(segment) > len("trace="):
                    trace_ids.append(segment[len("trace=") :])
            if not response.get("IsTruncated"):
                break
            continuation = response.get("NextContinuationToken")
            if not continuation:
                break
        return trace_ids[:limit]
