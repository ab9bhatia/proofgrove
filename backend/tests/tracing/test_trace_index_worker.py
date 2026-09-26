"""Trace-index worker: honest lifecycle transitions from real signals only.

The worker (a) upserts index rows for evaluation run items that carry genuine
trace ids, (b) confirms them against the S3 trace archive (mock gateway here)
recording span statistics, and (c) discovers non-evaluation production traces
from the archive's trace-index/ pointer prefix. States are never fabricated:
``requested`` until the archive is actually checked, ``pending_export`` when a
check found nothing, ``archive_confirmed`` only for real spans, and
``archive_unavailable`` when the archive errored.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from proofgrove.db.models import (
    Base,
    CapturedSpanIndexORM,
    CapturedTraceIndexORM,
    EvaluationProjectORM,
    EvaluationRunItemORM,
    EvaluationRunORM,
    ExperimentORM,
    TargetProjectBindingORM,
)
from proofgrove.db.store import EvaluationStore
from proofgrove.evaluation.models import ArchivedTraceSpan, RunItemTraceEvidence
from proofgrove.platform.payloads import TRUNCATION_MARKER
from proofgrove.settings import settings
from proofgrove.tracing.index_worker import run_trace_index_tick
from proofgrove.tracing.models import (
    SPAN_INDEX_REV,
    SPAN_PREVIEW_MAX_CHARS,
    TraceLifecycleState,
    semantic_span_kind,
    span_index_rows_from_spans,
    trace_stats_from_spans,
)

TENANT = "tenant-index"
NOW = datetime(2026, 8, 23, 12, 0, 0, tzinfo=UTC)


@pytest.fixture
async def session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    yield factory
    await engine.dispose()


def _span(
    trace_id: str,
    span_id: str,
    *,
    parent: str | None = None,
    name: str = "span",
    kind: int | None = 2,
    start_ns: int = 1_766_000_000_000_000_000,
    end_ns: int = 1_766_000_001_500_000_000,
    error: bool = False,
    attributes: dict | None = None,
    resource: dict | None = None,
) -> ArchivedTraceSpan:
    return ArchivedTraceSpan(
        trace_id=trace_id,
        span_id=span_id,
        parent_span_id=parent,
        name=name,
        kind=kind,
        start_time_unix_nano=str(start_ns),
        end_time_unix_nano=str(end_ns),
        duration_ms=(end_ns - start_ns) / 1_000_000,
        status={"code": 2} if error else {"code": 1},
        attributes=attributes or {},
        resource_attributes=resource or {},
    )


class FakeGateway:
    """Archive gateway double: canned evidence per trace, optional failures."""

    def __init__(
        self,
        evidence: dict[str, RunItemTraceEvidence] | None = None,
        archived_ids: list[str] | None = None,
        broken_ids: set[str] | None = None,
    ) -> None:
        self.evidence = evidence or {}
        self.archived_ids = archived_ids or []
        self.broken_ids = broken_ids or set()
        self.find_calls: list[str] = []
        self.tenants: list[str] = []

    async def find(self, *, trace_id, tenant, started_at=None, completed_at=None):
        self.find_calls.append(trace_id)
        self.tenants.append(tenant)
        if trace_id in self.broken_ids:
            raise RuntimeError("archive unreachable")
        return self.evidence.get(
            trace_id,
            RunItemTraceEvidence(state="not_found", trace_id=trace_id),
        )

    async def list_archived_trace_ids(self, tenant, *, limit):
        self.tenants.append(tenant)
        return self.archived_ids[:limit]


async def _seed_eval_trace(
    factory,
    *,
    trace_id: str,
    tenant: str = TENANT,
    project_id: str | None = None,
    create_project: bool = True,
) -> str:
    """Persist project → experiment → run → run item carrying ``trace_id``."""
    project_id = project_id or f"proj-{uuid.uuid4().hex[:8]}"
    experiment_id = f"exp-{uuid.uuid4().hex[:8]}"
    run_id = f"run-{uuid.uuid4().hex[:8]}"
    async with factory() as session:
        if create_project:
            session.add(
                EvaluationProjectORM(
                    project_id=project_id,
                    tenant_id=tenant,
                    name="Support agent",
                    system_type="agent",
                    owner="quality",
                    purpose="system",
                )
            )
        session.add(
            ExperimentORM(
                experiment_id=experiment_id,
                name="Support quality",
                dataset_version="support.v1",
                target_endpoint="tenant/support-agent",
                scenario="llm_core",
                tenant_id=tenant,
                project_id=project_id,
            )
        )
        session.add(
            EvaluationRunORM(
                run_id=run_id,
                experiment_id=experiment_id,
                status="completed",
                started_at=NOW - timedelta(minutes=10),
                completed_at=NOW - timedelta(minutes=9),
            )
        )
        session.add(
            EvaluationRunItemORM(
                run_id=run_id,
                example_id="case-1",
                sequence_position=0,
                dataset_version="support.v1",
                trace_id=trace_id,
                captured_at=NOW - timedelta(minutes=9),
                evidence_ref=f"db://evaluation_run_items/{run_id}/case-1",
                redaction_enabled=True,
                max_persisted_string_size=20_000,
            )
        )
        await session.commit()
    return project_id


async def _index_row(factory, trace_id: str, tenant: str = TENANT) -> CapturedTraceIndexORM | None:
    async with factory() as session:
        return await session.get(CapturedTraceIndexORM, (tenant, trace_id))


async def test_tick_upserts_requested_rows_from_run_items(session_factory):
    project_id = await _seed_eval_trace(session_factory, trace_id="trace-upsert")
    counts = await run_trace_index_tick(tenant=TENANT, gateway=FakeGateway(), session_factory=session_factory, now=NOW)
    assert counts["upserted"] == 1

    row = await _index_row(session_factory, "trace-upsert")
    assert row is not None
    assert row.lifecycle_state == TraceLifecycleState.REQUESTED.value
    assert row.is_evaluated is True
    assert row.project_id == project_id
    assert row.started_at.replace(tzinfo=UTC) == NOW - timedelta(minutes=9)
    # The archive was never checked (archive disabled): nothing is fabricated.
    assert row.span_count is None
    assert row.last_checked_at is None

    # Idempotent: a second tick does not duplicate or reset the row.
    counts = await run_trace_index_tick(tenant=TENANT, gateway=FakeGateway(), session_factory=session_factory, now=NOW)
    assert counts["upserted"] == 0


async def test_tick_backfills_evaluation_capture_time_on_existing_index_row(session_factory):
    await _seed_eval_trace(session_factory, trace_id="trace-capture-time")
    async with session_factory() as session:
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-capture-time",
                lifecycle_state=TraceLifecycleState.PENDING_EXPORT.value,
                is_evaluated=True,
                created_at=NOW,
            )
        )
        await session.commit()

    await run_trace_index_tick(tenant=TENANT, gateway=FakeGateway(), session_factory=session_factory, now=NOW)

    row = await _index_row(session_factory, "trace-capture-time")
    assert row is not None
    assert row.started_at.replace(tzinfo=UTC) == NOW - timedelta(minutes=9)


async def test_tick_confirms_archived_spans_with_real_statistics(session_factory, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    await _seed_eval_trace(session_factory, trace_id="trace-confirm")
    spans = [
        _span(
            "trace-confirm",
            "root",
            name="agent.run",
            attributes={"openinference.span.kind": "AGENT"},
            kind=2,
            start_ns=1_766_000_000_000_000_000,
            end_ns=1_766_000_002_000_000_000,
        ),
        _span(
            "trace-confirm",
            "child",
            parent="root",
            name="llm.call",
            kind=3,
            start_ns=1_766_000_000_500_000_000,
            end_ns=1_766_000_001_000_000_000,
            error=True,
            attributes={"openinference.span.kind": "LLM", "gen_ai.request.model": "gpt-4o-mini"},
        ),
    ]
    gateway = FakeGateway(evidence={"trace-confirm": RunItemTraceEvidence(state="available", trace_id="trace-confirm", spans=spans)})
    counts = await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)
    assert counts["confirmed"] == 1

    row = await _index_row(session_factory, "trace-confirm")
    assert row.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value
    assert row.span_count == 2
    assert row.error_count == 1
    assert row.root_span_name == "agent.run"
    assert row.root_span_kind == "agent"
    assert row.model == "gpt-4o-mini"
    assert row.duration_ms == pytest.approx(2_000.0)
    assert row.started_at is not None
    assert row.last_checked_at is not None

    async with session_factory() as session:
        store = EvaluationStore(session)
        page = await store.list_span_index_page(TENANT, None, limit=10)
    # Spans indexed under the trace's project, not unassigned.
    assert page["total"] == 0
    async with session_factory() as session:
        span_rows = (await session.execute(CapturedSpanIndexORM.__table__.select())).mappings().all()
    assert {r["span_id"] for r in span_rows} == {"root", "child"}
    assert {r["status"] for r in span_rows} == {"ok", "error"}


async def test_tick_uses_namespace_for_index_and_slug_for_archive(session_factory, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    tenant = "tenant-evalai"
    await _seed_eval_trace(session_factory, trace_id="trace-tenant", tenant=tenant)
    gateway = FakeGateway(
        evidence={
            "trace-tenant": RunItemTraceEvidence(
                state="available",
                trace_id="trace-tenant",
                spans=[_span("trace-tenant", "root")],
            )
        }
    )

    await run_trace_index_tick(tenant=tenant, gateway=gateway, session_factory=session_factory, now=NOW)

    assert await _index_row(session_factory, "trace-tenant", tenant) is not None
    assert gateway.tenants and set(gateway.tenants) == {"evalai"}


async def test_tick_backfills_confirmed_trace_without_span_rows(session_factory, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    async with session_factory() as session:
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-needs-backfill",
                lifecycle_state=TraceLifecycleState.ARCHIVE_CONFIRMED.value,
                span_count=1,
                is_evaluated=False,
                created_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()
    gateway = FakeGateway(
        evidence={
            "trace-needs-backfill": RunItemTraceEvidence(
                state="available",
                trace_id="trace-needs-backfill",
                spans=[_span("trace-needs-backfill", "root", name="agent.run")],
            )
        }
    )

    counts = await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)

    assert counts["backfilled"] == 1
    async with session_factory() as session:
        span = await session.get(CapturedSpanIndexORM, (TENANT, "trace-needs-backfill", "root"))
    assert span is not None


async def test_tick_marks_pending_and_unavailable_and_keeps_going(session_factory, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    await _seed_eval_trace(session_factory, trace_id="trace-broken")
    await _seed_eval_trace(session_factory, trace_id="trace-empty")
    await _seed_eval_trace(session_factory, trace_id="trace-ok")
    gateway = FakeGateway(
        evidence={
            "trace-ok": RunItemTraceEvidence(
                state="available",
                trace_id="trace-ok",
                spans=[_span("trace-ok", "root", name="agent.run")],
            )
        },
        broken_ids={"trace-broken"},
    )
    counts = await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)
    assert counts["unavailable"] == 1
    assert counts["pending"] == 1
    assert counts["confirmed"] == 1  # the broken trace never stopped the others

    broken = await _index_row(session_factory, "trace-broken")
    assert broken.lifecycle_state == TraceLifecycleState.ARCHIVE_UNAVAILABLE.value
    empty = await _index_row(session_factory, "trace-empty")
    assert empty.lifecycle_state == TraceLifecycleState.PENDING_EXPORT.value
    assert empty.span_count is None  # never fabricated
    ok = await _index_row(session_factory, "trace-ok")
    assert ok.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value


async def test_tick_discovers_non_evaluation_traces_from_archive(session_factory, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    monkeypatch.setattr(settings, "trace_archive_environment", "local")
    # A bound system project lets resource attributes resolve a Project home.
    async with session_factory() as session:
        session.add(
            EvaluationProjectORM(
                project_id="proj-bound",
                tenant_id=TENANT,
                name="Prod agent",
                system_type="agent",
                owner="quality",
                purpose="system",
            )
        )
        session.add(
            TargetProjectBindingORM(
                binding_id=str(uuid.uuid4()),
                tenant_id=TENANT,
                target_id="support-agent",
                environment="local",
                system_project_id="proj-bound",
            )
        )
        await session.commit()

    bound_spans = [
        _span(
            "prod-bound",
            "root",
            name="agent.serve",
            resource={"service.name": "support-agent"},
        )
    ]
    orphan_spans = [_span("prod-orphan", "root", name="cron.job", resource={})]
    gateway = FakeGateway(
        evidence={
            "prod-bound": RunItemTraceEvidence(state="available", trace_id="prod-bound", spans=bound_spans),
            "prod-orphan": RunItemTraceEvidence(state="available", trace_id="prod-orphan", spans=orphan_spans),
        },
        archived_ids=["prod-bound", "prod-orphan"],
    )
    counts = await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)
    assert counts["discovered"] == 2
    assert counts["confirmed"] == 2

    bound = await _index_row(session_factory, "prod-bound")
    assert bound.is_evaluated is False
    assert bound.project_id == "proj-bound"  # resolved through TargetProjectBinding
    assert bound.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value

    orphan = await _index_row(session_factory, "prod-orphan")
    assert orphan.is_evaluated is False
    assert orphan.project_id is None  # honest Unassigned, never guessed
    assert orphan.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value

    # Discovery is idempotent across ticks.
    counts = await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)
    assert counts["discovered"] == 0


async def test_pending_rows_beyond_grace_window_are_not_rechecked(session_factory, monkeypatch):
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    monkeypatch.setattr(settings, "trace_index_pending_grace_seconds", 3600.0)
    async with session_factory() as session:
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-stale",
                lifecycle_state=TraceLifecycleState.PENDING_EXPORT.value,
                is_evaluated=True,
                created_at=NOW - timedelta(hours=3),
                last_checked_at=NOW - timedelta(hours=2),
            )
        )
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-fresh",
                lifecycle_state=TraceLifecycleState.PENDING_EXPORT.value,
                is_evaluated=True,
                created_at=NOW - timedelta(minutes=5),
                last_checked_at=NOW - timedelta(minutes=4),
            )
        )
        await session.commit()

    gateway = FakeGateway()
    await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)
    assert "trace-fresh" in gateway.find_calls
    assert "trace-stale" not in gateway.find_calls  # stays pending_export, no churn


# Attribute sets below are the shapes real archived spans carry, not invented
# ones: a generation call may record no operation name at all, and a tool
# execution carries model-request attributes belonging to the call it wraps.
@pytest.mark.parametrize(
    ("name", "attributes", "expected"),
    [
        (
            "openai.chat",
            {
                "gen_ai.request.model": "gpt-5.1",
                "gen_ai.prompt.0.content": "hello",
                "gen_ai.completion.0.content": "hi",
                "gen_ai.usage.input_tokens": "1591",
            },
            "llm",
        ),
        (
            "generate_content gpt-5.1",
            {"gen_ai.operation.name": "generate_content", "gen_ai.request.model": "gpt-5.1"},
            "llm",
        ),
        (
            "call_llm",
            {"gen_ai.request.model": "gpt-5.1", "gcp.vertex.agent.llm_request": "{}"},
            "llm",
        ),
        (
            "invoke_agent agent_builder",
            {"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "agent_builder"},
            "agent",
        ),
        (
            "execute_tool create_agent",
            {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": "create_agent",
                # Rides on the tool span; must not read as a generation.
                "gcp.vertex.agent.llm_request": "{}",
            },
            "tool",
        ),
        ("POST / http send", {"asgi.event.type": "http.response.body"}, None),
        ("a2a.server.events.event_queue.EventQueue.dequeue_event", {}, None),
        ("a2a.utils.helpers.append_artifact_to_task", {}, None),
        ("GET", {}, None),
        # Ambient correlation attributes ride on plumbing too, so they alone
        # must not promote a span into the listing.
        ("some.framework.step", {"gen_ai.conversation.id": "c", "gen_ai.task.id": "t"}, None),
    ],
)
def test_semantic_span_kind_classifies_observed_span_shapes(name, attributes, expected):
    span = _span("trace", "s", name=name, attributes=attributes)
    assert semantic_span_kind(span) == expected


def test_tracing_uses_recorded_types_without_classifying_legacy_telemetry():
    typed = _span("trace", "agent", kind=1, attributes={"openinference.span.kind": "AGENT"})
    legacy = _span("trace", "old", name="call_llm", error=True, attributes={"gen_ai.request.model": "gpt-5.1"})
    rows = span_index_rows_from_spans([legacy, typed], limit=10)
    assert {row["span_id"]: row["semantic_kind"] for row in rows} == {"agent": "agent", "old": None}
    stats = trace_stats_from_spans([legacy, typed])
    assert stats.span_count == 1
    assert stats.error_count == 0
    # Historical traces retain their timing and name, but have no invented AI type.
    old_stats = trace_stats_from_spans([legacy])
    assert old_stats.span_count == 0
    assert old_stats.root_span_kind is None
    assert old_stats.root_span_name == "call_llm"
    assert old_stats.duration_ms == legacy.duration_ms


def test_span_index_rows_carry_previews_and_token_counts():
    span = _span(
        "trace",
        "llm-span",
        name="generate_content gpt-5.1",
        attributes={
            "openinference.span.kind": "LLM",
            "gen_ai.operation.name": "generate_content",
            "gen_ai.prompt.0.content": "what is the capital?",
            "gen_ai.completion.0.content": "Abu Dhabi",
            # OTLP/JSON encodes int64 as a string; a numeric-only reader would
            # silently record no tokens for every real span.
            "gen_ai.usage.input_tokens": "1591",
            "gen_ai.usage.output_tokens": "179",
        },
    )

    row = span_index_rows_from_spans([span], limit=10)[0]

    assert row["semantic_kind"] == "llm"
    assert row["input_preview"] == "what is the capital?"
    assert row["output_preview"] == "Abu Dhabi"
    assert row["llm_token_count_prompt"] == 1591
    assert row["llm_token_count_completion"] == 179
    assert "estimated_cost_usd" in row
    # A recorded OpenInference type takes precedence in display labels.
    assert row["kind"] == "llm"


def test_span_previews_fall_back_to_framework_request_attributes():
    span = _span(
        "trace",
        "adk",
        name="call_llm",
        attributes={
            "openinference.span.kind": "LLM",
            "gen_ai.request.model": "gpt-5.1",
            "gcp.vertex.agent.llm_request": "REQUEST BODY",
            "gcp.vertex.agent.llm_response": "RESPONSE BODY",
        },
    )

    row = span_index_rows_from_spans([span], limit=10)[0]

    assert row["semantic_kind"] == "llm"
    assert row["input_preview"] == "REQUEST BODY"
    assert row["output_preview"] == "RESPONSE BODY"


def test_span_previews_are_redacted_and_bounded():
    span = _span(
        "trace",
        "secret",
        name="openai.chat",
        attributes={
            "openinference.span.kind": "LLM",
            "gen_ai.request.model": "gpt-5.1",
            "input.value": "Authorization: Bearer abc123secret " + ("x" * 2000),
        },
    )

    preview = span_index_rows_from_spans([span], limit=10)[0]["input_preview"]

    assert "abc123secret" not in preview
    assert len(preview) <= SPAN_PREVIEW_MAX_CHARS
    assert preview.endswith(TRUNCATION_MARKER)


def test_span_previews_stay_bounded_when_redaction_is_disabled(monkeypatch):
    """The column promises a bounded preview in every configuration."""
    monkeypatch.setattr(settings, "payload_redaction_enabled", False)
    span = _span(
        "trace",
        "raw",
        name="openai.chat",
        attributes={"openinference.span.kind": "LLM", "gen_ai.request.model": "gpt-5.1", "input.value": "y" * 2000},
    )

    preview = span_index_rows_from_spans([span], limit=10)[0]["input_preview"]

    assert len(preview) <= SPAN_PREVIEW_MAX_CHARS


def test_span_index_spends_its_budget_on_semantic_spans_first():
    """A trace can bury its model calls behind hundreds of plumbing spans."""
    spans = [_span("trace", f"noise-{i}", name="a2a.queue.enqueue_event") for i in range(240)]
    spans.append(_span("trace", "late-llm", name="openai.chat", attributes={"openinference.span.kind": "LLM", "gen_ai.request.model": "m"}))

    rows = span_index_rows_from_spans(spans, limit=200)

    assert len(rows) == 200
    assert [row["span_id"] for row in rows if row["semantic_kind"]] == ["late-llm"]


async def test_tick_rebuilds_span_rows_derived_by_an_older_revision(session_factory, monkeypatch):
    """A change to the derivation has to reach traces already indexed."""
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    async with session_factory() as session:
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-stale",
                lifecycle_state=TraceLifecycleState.ARCHIVE_CONFIRMED.value,
                span_count=1,
                is_evaluated=False,
                span_index_rev=None,
                created_at=NOW - timedelta(days=1),
            )
        )
        # Already has a span row, so a missing-rows selector would skip it.
        session.add(
            CapturedSpanIndexORM(
                tenant_id=TENANT,
                trace_id="trace-stale",
                span_id="root",
                name="openai.chat",
                status="ok",
            )
        )
        await session.commit()
    gateway = FakeGateway(
        evidence={
            "trace-stale": RunItemTraceEvidence(
                state="available",
                trace_id="trace-stale",
                spans=[
                    _span(
                        "trace-stale",
                        "root",
                        name="openai.chat",
                        attributes={
                            "openinference.span.kind": "LLM",
                            "gen_ai.request.model": "gpt-5.1",
                            "gen_ai.completion.0.content": "hi",
                        },
                    )
                ],
            )
        }
    )

    await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)

    async with session_factory() as session:
        span = await session.get(CapturedSpanIndexORM, (TENANT, "trace-stale", "root"))
        trace = await session.get(CapturedTraceIndexORM, (TENANT, "trace-stale"))
    assert span.semantic_kind == "llm"
    assert span.output_preview == "hi"
    assert trace.span_index_rev == SPAN_INDEX_REV


async def test_a_truncated_reread_does_not_replace_a_fuller_summary(session_factory, monkeypatch):
    """A partial read is a partial view, not a smaller trace.

    Rebuild sweeps re-read every confirmed trace. If an archive object has since
    crossed the size cap the read comes back truncated, and overwriting on that
    would delete good span rows and rewrite the trace summary from the fragment
    that survived.
    """
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    async with session_factory() as session:
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-big",
                lifecycle_state=TraceLifecycleState.ARCHIVE_CONFIRMED.value,
                span_count=60,
                is_evaluated=False,
                span_index_rev=None,
                created_at=NOW - timedelta(days=1),
            )
        )
        session.add(
            CapturedSpanIndexORM(
                tenant_id=TENANT,
                trace_id="trace-big",
                span_id="root",
                name="openai.chat",
                status="ok",
                semantic_kind="llm",
            )
        )
        await session.commit()

    gateway = FakeGateway(
        evidence={
            "trace-big": RunItemTraceEvidence(
                state="available",
                trace_id="trace-big",
                truncated=True,
                spans=[_span("trace-big", "fragment", name="GET")],
            )
        }
    )

    await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)

    async with session_factory() as session:
        kept = await session.get(CapturedSpanIndexORM, (TENANT, "trace-big", "root"))
        fragment = await session.get(CapturedSpanIndexORM, (TENANT, "trace-big", "fragment"))
        trace = await session.get(CapturedTraceIndexORM, (TENANT, "trace-big"))

    assert kept is not None, "the fuller summary must survive a truncated re-read"
    assert fragment is None
    assert trace.span_count == 60
    # Left unstamped so a later, complete read still derives this trace.
    assert trace.span_index_rev is None


async def test_a_trace_the_archive_cannot_serve_yet_stays_rebuildable(session_factory, monkeypatch):
    """An empty read is "nothing this time", never "nothing ever".

    A lookup can come back empty for a trace whose data is really there — the
    read is bounded by a time window, and an export can still be in flight. If
    that were recorded as a completed derivation the rows would be stranded
    against every later attempt, so the trace stays selectable. Cost is bounded
    by the queue: candidates are taken least-recently-checked first, so an
    unreadable trace is re-read once per rotation, not once per tick.
    """
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    async with session_factory() as session:
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-not-yet",
                lifecycle_state=TraceLifecycleState.ARCHIVE_CONFIRMED.value,
                span_count=1,
                is_evaluated=False,
                span_index_rev=None,
                created_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()
    gateway = FakeGateway()  # the first read finds nothing

    await run_trace_index_tick(tenant=TENANT, gateway=gateway, session_factory=session_factory, now=NOW)

    async with session_factory() as session:
        trace = await session.get(CapturedTraceIndexORM, (TENANT, "trace-not-yet"))
    # Not demoted, and not recorded as derived.
    assert trace.lifecycle_state == TraceLifecycleState.ARCHIVE_CONFIRMED.value
    assert trace.span_index_rev is None

    # The data lands; the next pass must still pick the trace up.
    gateway.evidence["trace-not-yet"] = RunItemTraceEvidence(
        state="available",
        trace_id="trace-not-yet",
        spans=[
            _span(
                "trace-not-yet",
                "root",
                name="openai.chat",
                attributes={"openinference.span.kind": "LLM", "gen_ai.request.model": "gpt-5.1"},
            )
        ],
    )
    await run_trace_index_tick(
        tenant=TENANT,
        gateway=gateway,
        session_factory=session_factory,
        now=NOW + timedelta(minutes=1),
    )

    async with session_factory() as session:
        span = await session.get(CapturedSpanIndexORM, (TENANT, "trace-not-yet", "root"))
        trace = await session.get(CapturedTraceIndexORM, (TENANT, "trace-not-yet"))
    assert span is not None and span.semantic_kind == "llm"
    assert trace.span_index_rev == SPAN_INDEX_REV


async def test_archive_errors_stay_retryable_across_ticks(session_factory, monkeypatch):
    """A transient outage must not be mistaken for an aged-out object."""
    monkeypatch.setattr(settings, "trace_archive_enabled", True)
    async with session_factory() as session:
        session.add(
            CapturedTraceIndexORM(
                tenant_id=TENANT,
                trace_id="trace-flaky",
                lifecycle_state=TraceLifecycleState.ARCHIVE_CONFIRMED.value,
                span_count=1,
                is_evaluated=False,
                span_index_rev=None,
                created_at=NOW - timedelta(days=1),
            )
        )
        await session.commit()
    gateway = FakeGateway(broken_ids={"trace-flaky"})

    for tick in range(2):
        await run_trace_index_tick(
            tenant=TENANT,
            gateway=gateway,
            session_factory=session_factory,
            now=NOW + timedelta(minutes=tick),
        )

    assert gateway.find_calls.count("trace-flaky") == 2


@pytest.mark.parametrize(
    ("recorded", "expected"),
    [
        ("1591", 1591),
        (1591, 1591),
        # A negative reading is absent evidence, not zero tokens.
        ("-0.5", None),
        (-1, None),
        # An overflowing literal must not escape as an exception.
        ("1e400", None),
        ("not a number", None),
        (True, None),
        (None, None),
    ],
)
def test_token_counts_are_read_only_from_whole_non_negative_numbers(recorded, expected):
    attributes = {"openinference.span.kind": "LLM", "gen_ai.request.model": "gpt-5.1"}
    if recorded is not None:
        attributes["gen_ai.usage.input_tokens"] = recorded
    span = _span("trace", "s", name="openai.chat", attributes=attributes)

    row = span_index_rows_from_spans([span], limit=10)[0]

    assert row["llm_token_count_prompt"] == expected


def test_a_preview_never_exceeds_its_bound_even_below_the_marker_length(monkeypatch):
    """The bound is the promise; the truncation marker does not get to break it."""
    monkeypatch.setattr("proofgrove.tracing.models.SPAN_PREVIEW_MAX_CHARS", 4)
    span = _span(
        "trace",
        "s",
        name="openai.chat",
        attributes={"openinference.span.kind": "LLM", "gen_ai.request.model": "gpt-5.1", "input.value": "y" * 500},
    )

    assert len(span_index_rows_from_spans([span], limit=10)[0]["input_preview"]) <= 4
