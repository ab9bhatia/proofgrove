"""Tests for telemetry-as-source-of-truth scoring hydration."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from proofgrove.evaluation.enums import EvaluationScope, ProvenanceStatus
from proofgrove.evaluation.models import (
    ArchivedTraceSpan,
    EvaluationRow,
    RunItemTraceEvidence,
    ToolCall,
)
from proofgrove.evaluation.trace_hydrator import (
    A2A_FALLBACK_EVIDENCE_SOURCE,
    TELEMETRY_EVIDENCE_SOURCE,
    TELEMETRY_PENDING_SOURCE,
    apply_telemetry_to_row,
    extract_scoring_evidence,
    hydrate_row_from_archive,
    incomplete_archive_mode,
    trace_evidence_fingerprint,
    uses_a2a_capture_for_scoring,
    wait_for_archived_trace,
)
from proofgrove.settings import Settings

TRACE_ID = "0123456789abcdef0123456789abcdef"


def _span(span_id: str, **attributes) -> ArchivedTraceSpan:
    return ArchivedTraceSpan(
        trace_id=TRACE_ID,
        span_id=span_id,
        name=str(attributes.get("name") or span_id),
        start_time_unix_nano=attributes.pop("start", "1"),
        attributes={k: v for k, v in attributes.items() if k != "name"},
    )


def _row(**kwargs) -> EvaluationRow:
    base = dict(
        row_id="r1",
        query="What is AAPL revenue?",
        response="session answer",
        from_agent=True,
        trace_id=TRACE_ID,
        tool_calls=[ToolCall(name="session_tool", output="from session")],
        retrieval_snippets=["dataset context"],
        context=["dataset context", "from session"],
    )
    base.update(kwargs)
    return EvaluationRow(**base)


def test_extracts_openinference_agent_output_and_tool_call():
    response, tools, retrieval = extract_scoring_evidence(
        [
            _span(
                "agent",
                **{
                    "openinference.span.kind": "AGENT",
                    "output.value": "archive answer",
                    "start": "30",
                },
            ),
            _span(
                "search",
                **{
                    "openinference.span.kind": "TOOL",
                    "tool.name": "search",
                    "tool.parameters": '{"q": "AAPL"}',
                    "output.value": "383B",
                    "start": "10",
                },
            ),
        ]
    )
    assert response == "archive answer"
    assert [call.name for call in tools] == ["search"]
    assert tools[0].args == {"q": "AAPL"}
    assert tools[0].output == "383B"
    assert tools[0].result_captured is True
    assert retrieval == []


def test_sort_tolerates_unparseable_start_time():
    """A malformed start_time_unix_nano must sort as 0, not crash the read."""
    response, tools, _ = extract_scoring_evidence(
        [
            _span(
                "tool",
                **{
                    "gen_ai.tool.name": "first",
                    "gen_ai.operation.name": "execute_tool",
                    "start": "not-a-number",
                },
            ),
            _span(
                "agent",
                **{
                    "openinference.span.kind": "AGENT",
                    "output.value": "ok",
                    "start": "10",
                },
            ),
        ]
    )
    assert response == "ok"
    assert [call.name for call in tools] == ["first"]


def test_extracts_retriever_documents_and_gen_ai_tool():
    response, tools, retrieval = extract_scoring_evidence(
        [
            _span(
                "retrieve",
                **{
                    "openinference.span.kind": "RETRIEVER",
                    "retrieval.documents.1.document.content": "second chunk",
                    "retrieval.documents.0.document.content": "first chunk",
                },
            ),
            _span(
                "tool",
                **{
                    "gen_ai.tool.name": "lookup",
                    "gen_ai.operation.name": "execute_tool",
                    "input.value": '{"id": 7}',
                    "output.value": {"documents": [{"id": 7}]},
                },
            ),
            _span(
                "llm",
                **{
                    "openinference.span.kind": "LLM",
                    "gen_ai.completion.0.content": "final from llm",
                },
            ),
        ]
    )
    assert response == "final from llm"
    assert retrieval == ["first chunk", "second chunk"]
    assert tools[0].name == "lookup"
    assert tools[0].args == {"id": 7}


def test_hydrates_kagent_mcp_arguments_response_and_scoring_context():
    payload = '{"content": [{"type": "text", "text": "84.0"}], "structuredContent": {"result": 84.0}, "isError": false}'
    row = _row()
    apply_telemetry_to_row(row, RunItemTraceEvidence(
        state="available", trace_id=TRACE_ID,
        pagination_complete=True, lifecycle_complete=True, evidence_complete=True,
        spans=[_span("tool", **{
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "multiply",
            "gcp.vertex.agent.tool_call_args": '{"a": 12, "b": 7}',
            "gcp.vertex.agent.tool_response": payload,
        })],
    ))
    assert len(row.tool_calls) == 1
    assert row.tool_calls[0].name == "multiply"
    assert row.tool_calls[0].args == {"a": 12, "b": 7}
    assert row.tool_calls[0].output == payload
    assert row.tool_calls[0].result_captured is True
    assert row.context == ["dataset context", payload]
    assert row.tool_evidence_provenance_status == ProvenanceStatus.ATTESTED


@pytest.mark.parametrize("output", [0, False, "", {}, [], None])
def test_kagent_tool_response_preserves_falsy_and_missing_values(output):
    _, tools, _ = extract_scoring_evidence([_span("tool", **{
        "gen_ai.tool.name": "lookup",
        "gcp.vertex.agent.tool_call_args": {},
        "gcp.vertex.agent.tool_response": output,
    })])
    assert tools[0].args == {}
    assert tools[0].output == output
    assert tools[0].result_captured is (output is not None)


@pytest.mark.parametrize("output_key", ["output.value", "tool.output", "gen_ai.tool.call.result"])
def test_standard_tool_attributes_take_precedence_over_kagent(output_key):
    _, tools, _ = extract_scoring_evidence([_span("tool", **{
        "gen_ai.tool.name": "lookup",
        "tool.parameters": {},
        output_key: False,
        "gcp.vertex.agent.tool_call_args": '{"ignored": true}',
        "gcp.vertex.agent.tool_response": "ignored",
    })])
    assert tools[0].args == {}
    assert tools[0].output is False
    assert tools[0].result_captured is True


def test_trace_fingerprint_changes_when_attribute_interpretation_improves(monkeypatch):
    from proofgrove.evaluation import trace_hydrator

    evidence = RunItemTraceEvidence(state="available", trace_id=TRACE_ID, spans=[
        _span("tool", **{
            "gen_ai.tool.name": "multiply",
            "gcp.vertex.agent.tool_call_args": '{"a": 12, "b": 7}',
            "gcp.vertex.agent.tool_response": "84.0",
        }),
    ])
    with monkeypatch.context() as patch:
        patch.setattr(trace_hydrator, "_tool_call_from_span", lambda _span: ToolCall(name="multiply"))
        old_fingerprint = trace_evidence_fingerprint(evidence)

    assert trace_evidence_fingerprint(evidence) != old_fingerprint
    assert trace_evidence_fingerprint(evidence) == trace_evidence_fingerprint(evidence.model_copy(deep=True))


def test_apply_externalizes_oversized_archived_tool_output():
    """R10: archive hydration must enforce the same inline budget as capture."""
    big_output = "x" * 50
    row = _row()
    apply_telemetry_to_row(
        row,
        RunItemTraceEvidence(
            state="available",
            trace_id=TRACE_ID,
            pagination_complete=True,
            lifecycle_complete=True,
            evidence_complete=True,
            spans=[
                _span(
                    "search",
                    **{
                        "openinference.span.kind": "TOOL",
                        "tool.name": "search",
                        "output.value": big_output,
                    },
                ),
            ],
        ),
        settings=Settings(agent_max_inline_tool_result_bytes=10),
    )
    assert len(row.tool_result_artifacts) == 1
    artifact = row.tool_result_artifacts[0]
    assert artifact.tool_name == "search"
    assert artifact.content == big_output
    assert artifact.size_bytes == len(big_output.encode("utf-8"))
    call = row.tool_calls[0]
    assert call.output["type"] == "artifact_reference"
    assert call.output["artifact_ref"] == artifact.artifact_ref
    assert call.output["truncated"] is True
    # Judge context must not carry the raw oversized output either.
    assert big_output not in "".join(row.context)


def test_apply_keeps_small_archived_tool_output_inline():
    row = _row()
    apply_telemetry_to_row(
        row,
        RunItemTraceEvidence(
            state="available",
            trace_id=TRACE_ID,
            pagination_complete=True,
            lifecycle_complete=True,
            evidence_complete=True,
            spans=[
                _span(
                    "search",
                    **{
                        "openinference.span.kind": "TOOL",
                        "tool.name": "search",
                        "output.value": "small",
                    },
                ),
            ],
        ),
        settings=Settings(agent_max_inline_tool_result_bytes=131_072),
    )
    assert row.tool_result_artifacts == []
    assert row.tool_calls[0].output == "small"
    assert "small" in row.context


def test_apply_overwrites_session_evidence_from_archive():
    row = _row(
        target_usage={"prompt_tokens": 12, "completion_tokens": 4}
    )
    apply_telemetry_to_row(
        row,
        RunItemTraceEvidence(
            state="available",
            trace_id=TRACE_ID,
            pagination_complete=True,
            lifecycle_complete=True,
            evidence_complete=True,
            spans=[
                _span(
                    "agent",
                    **{"openinference.span.kind": "AGENT", "output.value": "from spans"},
                ),
                _span(
                    "search",
                    **{
                        "openinference.span.kind": "TOOL",
                        "tool.name": "search",
                        "output.value": "span tool output",
                    },
                ),
            ],
        ),
    )
    assert row.response == "from spans"
    assert row.output_data["response_source"] == TELEMETRY_EVIDENCE_SOURCE
    assert [call.name for call in row.tool_calls] == ["search"]
    assert row.context == ["dataset context", "span tool output"]
    assert row.trace_unavailable is False
    assert row.tool_evidence_completion_attested is True
    assert row.trace_completion_attested is True
    assert row.model_usage_completion_attested is True
    assert row.lifecycle_completion_attested is True
    assert row.tool_evidence_provenance_status == ProvenanceStatus.ATTESTED
    assert row.tool_evidence_source == TELEMETRY_EVIDENCE_SOURCE


def test_apply_falls_back_to_a2a_capture_when_archive_missing():
    row = _row()
    apply_telemetry_to_row(
        row,
        RunItemTraceEvidence(state="pending", trace_id=TRACE_ID, message="still exporting"),
    )
    assert row.response == "session answer"
    assert [call.name for call in row.tool_calls] == ["session_tool"]
    assert row.context == ["dataset context", "from session"]
    assert row.trace_unavailable is False
    # The archive never confirmed this execution, so the session capture is
    # graded but cannot be reported as complete.
    assert row.tool_evidence_completion_attested is False
    assert row.trace_completion_attested is False
    assert row.model_usage_completion_attested is False
    assert row.lifecycle_completion_attested is False
    assert row.tool_evidence_provenance_status == ProvenanceStatus.SELF_REPORTED
    assert row.tool_evidence_source == A2A_FALLBACK_EVIDENCE_SOURCE
    assert row.output_data["response_source"] == A2A_FALLBACK_EVIDENCE_SOURCE
    assert row.output_data["archive_fallback_reason"] == "pending"


def test_apply_discards_session_tools_when_fallback_disabled():
    row = _row()
    apply_telemetry_to_row(
        row,
        RunItemTraceEvidence(state="pending", trace_id=TRACE_ID, message="still exporting"),
        fallback_to_capture=False,
    )
    assert row.response == "session answer"
    assert row.tool_calls == []
    assert row.context == ["dataset context"]
    assert row.trace_unavailable is True
    assert row.tool_evidence_completion_attested is False
    assert row.trace_completion_attested is False
    assert row.model_usage_completion_attested is False
    assert row.lifecycle_completion_attested is False
    assert row.tool_evidence_source is None


def test_truncated_archive_is_not_scored_until_complete():
    row = _row()
    apply_telemetry_to_row(
        row,
        RunItemTraceEvidence(
            state="available",
            trace_id=TRACE_ID,
            truncated=True,
            spans=[
                _span(
                    "agent",
                    **{"openinference.span.kind": "AGENT", "output.value": "partial"},
                )
            ],
        ),
        incomplete_mode="defer",
    )
    assert row.response == "session answer"
    assert row.output_data["response_source"] == TELEMETRY_PENDING_SOURCE
    assert row.output_data["archive_pending_reason"] == "incomplete_trajectory"
    assert [call.name for call in row.tool_calls] == ["session_tool"]
    assert row.tool_evidence_source != TELEMETRY_EVIDENCE_SOURCE


@pytest.mark.asyncio
async def test_wait_polls_until_spans_are_available():
    calls = {"n": 0}

    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            calls["n"] += 1
            if calls["n"] < 3:
                return RunItemTraceEvidence(state="pending", trace_id=TRACE_ID)
            return RunItemTraceEvidence(
                state="available",
                trace_id=TRACE_ID,
                pagination_complete=True,
                lifecycle_complete=True,
                evidence_complete=True,
                spans=[_span("agent", **{"output.value": "ok"})],
            )

    sleeps: list[float] = []

    async def _sleep(seconds):
        sleeps.append(seconds)

    evidence = await wait_for_archived_trace(
        _Reader(),
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        timeout_seconds=10,
        poll_seconds=0.5,
        sleep=_sleep,
    )
    assert evidence.state == "available"
    assert calls["n"] == 3
    assert sleeps == [0.5, 0.5]


@pytest.mark.asyncio
async def test_wait_does_not_accept_spans_until_trace_lifecycle_is_complete():
    calls = {"n": 0}

    class _Reader:
        async def find(self, **kwargs):
            assert kwargs["relevant_only"] is True
            calls["n"] += 1
            complete = calls["n"] == 2
            return RunItemTraceEvidence(
                state="available",
                trace_id=TRACE_ID,
                pagination_complete=True,
                lifecycle_complete=complete,
                evidence_complete=complete,
                spans=[_span("agent", **{"output.value": "ok"})],
            )

    async def _sleep(_seconds):
        return None

    evidence = await wait_for_archived_trace(
        _Reader(),
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        timeout_seconds=10,
        poll_seconds=0.1,
        sleep=_sleep,
    )

    assert calls["n"] == 2
    assert evidence.evidence_complete is True


@pytest.mark.asyncio
async def test_wait_requires_completed_archive_snapshot_to_settle():
    calls = {"n": 0}

    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            calls["n"] += 1
            object_refs = ["batch-a"] if calls["n"] == 1 else ["batch-a", "batch-b"]
            spans = [_span("agent", **{"output.value": "ok"})]
            if calls["n"] > 1:
                spans.append(_span("tool", **{"tool.name": "search"}))
            return RunItemTraceEvidence(
                state="available",
                trace_id=TRACE_ID,
                object_refs=object_refs,
                pagination_complete=True,
                lifecycle_complete=True,
                evidence_complete=True,
                spans=spans,
            )

    async def _sleep(_seconds):
        return None

    evidence = await wait_for_archived_trace(
        _Reader(),
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        timeout_seconds=10,
        poll_seconds=0.5,
        settle_seconds=1.0,
        sleep=_sleep,
    )

    assert calls["n"] == 4
    assert evidence.evidence_complete is True
    assert [span.span_id for span in evidence.spans] == ["agent", "tool"]


@pytest.mark.asyncio
async def test_wait_resets_settlement_when_existing_span_content_changes():
    calls = {"n": 0}

    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            calls["n"] += 1
            output = "draft" if calls["n"] == 1 else "final"
            return RunItemTraceEvidence(
                state="available",
                trace_id=TRACE_ID,
                object_refs=["batch-a"],
                pagination_complete=True,
                lifecycle_complete=True,
                evidence_complete=True,
                spans=[_span("agent", **{"output.value": output})],
            )

    async def _sleep(_seconds):
        return None

    evidence = await wait_for_archived_trace(
        _Reader(),
        trace_id=TRACE_ID,
        tenant="evalai",
        started_at=None,
        timeout_seconds=10,
        poll_seconds=0.5,
        settle_seconds=1.0,
        min_identical_observations=3,
        sleep=_sleep,
    )

    assert calls["n"] == 4
    assert evidence.spans[0].attributes["output.value"] == "final"


def test_trace_fingerprint_changes_when_same_span_is_finalized():
    def _evidence(output: str) -> RunItemTraceEvidence:
        return RunItemTraceEvidence(
            state="available",
            trace_id=TRACE_ID,
            object_refs=["batch-a"],
            pagination_complete=True,
            lifecycle_complete=True,
            evidence_complete=True,
            spans=[_span("agent", **{"output.value": output})],
        )

    assert trace_evidence_fingerprint(_evidence("draft")) != trace_evidence_fingerprint(
        _evidence("final")
    )


def test_trace_fingerprint_ignores_retrieval_time_but_keeps_execution_changes():
    span = _span("agent", **{"output.value": "answer"})
    span.retrieved_at = datetime(2026, 9, 8, tzinfo=UTC)
    evidence = RunItemTraceEvidence(state="available", trace_id=TRACE_ID, spans=[span])
    fingerprint = trace_evidence_fingerprint(evidence)
    span.retrieved_at += timedelta(seconds=10)
    assert trace_evidence_fingerprint(evidence) == fingerprint
    span.end_time_unix_nano = "100"
    assert trace_evidence_fingerprint(evidence) != fingerprint


@pytest.mark.asyncio
@pytest.mark.parametrize("settle_seconds", [0, 2])
async def test_completed_root_with_too_few_observations_reports_unsettled_archive(monkeypatch, settle_seconds):
    clock = SimpleNamespace(now=0.0)
    monkeypatch.setattr("proofgrove.evaluation.trace_hydrator.time", SimpleNamespace(monotonic=lambda: clock.now))

    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            clock.now += 1.25  # archive I/O consumes the short polling budget
            return RunItemTraceEvidence(
                state="available",
                trace_id=TRACE_ID,
                pagination_complete=True,
                lifecycle_complete=True,
                evidence_complete=True,
                spans=[_span("agent", **{"output.value": "ok"})],
            )

    async def _sleep(seconds):
        clock.now += seconds

    evidence = await wait_for_archived_trace(
        _Reader(), trace_id=TRACE_ID, tenant="evalai", started_at=None,
        timeout_seconds=4, poll_seconds=2, settle_seconds=settle_seconds,
        min_identical_observations=3, sleep=_sleep,
    )
    assert evidence.lifecycle_complete is True
    assert evidence.evidence_complete is False
    assert evidence.completion_diagnostic == "archive_not_settled"
    row = _row()
    apply_telemetry_to_row(row, evidence, incomplete_mode="defer")
    assert row.output_data["archive_pending_reason"] == "archive_not_settled"


@pytest.mark.asyncio
async def test_hydrate_is_noop_when_archive_disabled():
    row = _row()
    await hydrate_row_from_archive(
        row,
        tenant_id="evalai",
        settings=Settings(trace_archive_enabled=False, database_url="sqlite+aiosqlite://"),
    )
    assert [call.name for call in row.tool_calls] == ["session_tool"]
    assert row.response == "session answer"


@pytest.mark.asyncio
async def test_hydrate_row_replaces_session_capture():
    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            return RunItemTraceEvidence(
                state="available",
                trace_id=TRACE_ID,
                pagination_complete=True,
                lifecycle_complete=True,
                evidence_complete=True,
                spans=[
                    _span(
                        "agent",
                        **{
                            "openinference.span.kind": "AGENT",
                            "output.value": "telemetry answer",
                        },
                    )
                ],
            )

    row = _row()
    await hydrate_row_from_archive(
        row,
        tenant_id="evalai",
        settings=Settings(
            trace_archive_enabled=True,
            trace_archive_score_timeout_seconds=0,
            trace_archive_completion_min_identical_observations=1,
            database_url="sqlite+aiosqlite://",
        ),
        reader=_Reader(),
    )
    assert row.response == "telemetry answer"
    assert row.tool_calls == []
    assert row.tool_evidence_source == TELEMETRY_EVIDENCE_SOURCE


@pytest.mark.asyncio
async def test_hydrate_falls_back_to_a2a_when_wait_window_expires():
    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            return RunItemTraceEvidence(state="pending", trace_id=TRACE_ID)

    row = _row()
    await hydrate_row_from_archive(
        row,
        tenant_id="evalai",
        settings=Settings(
            trace_archive_enabled=True,
            trace_archive_score_timeout_seconds=0,
            trace_archive_deferred_score=False,
            trace_archive_score_fallback_to_capture=True,
            database_url="sqlite+aiosqlite://",
        ),
        reader=_Reader(),
    )
    assert row.response == "session answer"
    assert [call.name for call in row.tool_calls] == ["session_tool"]
    assert row.tool_evidence_source == A2A_FALLBACK_EVIDENCE_SOURCE
    assert row.tool_evidence_completion_attested is False
    assert row.trace_unavailable is False


def test_incomplete_trace_defaults_to_private_evidence_deferral():
    cfg = Settings(
        trace_archive_enabled=True,
        database_url="sqlite+aiosqlite://",
    )

    assert cfg.trace_archive_deferred_score is True
    assert incomplete_archive_mode(cfg, evaluation_scope=EvaluationScope.TOOL_INTERACTIONS) == "defer"
    assert incomplete_archive_mode(cfg, evaluation_scope=EvaluationScope.FINAL_RESPONSE) == "fallback"


@pytest.mark.asyncio
async def test_hydrate_can_disable_a2a_fallback():
    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            return RunItemTraceEvidence(state="pending", trace_id=TRACE_ID)

    row = _row()
    await hydrate_row_from_archive(
        row,
        tenant_id="evalai",
        settings=Settings(
            trace_archive_enabled=True,
            trace_archive_score_timeout_seconds=0,
            trace_archive_deferred_score=False,
            trace_archive_score_fallback_to_capture=False,
            database_url="sqlite+aiosqlite://",
        ),
        reader=_Reader(),
    )
    assert row.tool_calls == []
    assert row.trace_unavailable is True
    assert row.tool_evidence_source is None


@pytest.mark.asyncio
async def test_hydrate_strips_tenant_namespace_prefix_for_minio():
    seen: dict = {}

    class _Reader:
        async def find(self, **kwargs):
            seen.update(kwargs)
            return RunItemTraceEvidence(state="pending", trace_id=TRACE_ID)

    row = _row()
    await hydrate_row_from_archive(
        row,
        tenant_id="tenant-evalai",
        settings=Settings(
            trace_archive_enabled=True,
            trace_archive_score_timeout_seconds=0,
            trace_archive_deferred_score=False,
            trace_archive_score_fallback_to_capture=True,
            database_url="sqlite+aiosqlite://",
        ),
        reader=_Reader(),
    )
    assert seen["tenant"] == "evalai"
    assert row.tool_evidence_source == A2A_FALLBACK_EVIDENCE_SOURCE


def test_the_agents_own_output_is_the_response_not_the_last_model_turn():
    """An internal planning turn is not the delivered answer.

    Every kind comparison here used the OTLP transport kind, which equals none
    of agent/chain/llm, so the lookup always fell through to "the last span with
    any output". Harmless while the read returned nothing; wrong once it returns
    the model's internal turns.
    """

    agent = ArchivedTraceSpan(
        trace_id=TRACE_ID,
        span_id="agent",
        name="invoke_agent",
        start_time_unix_nano="1",
        attributes={"gen_ai.operation.name": "invoke_agent", "output.value": "the delivered answer"},
    )
    later_internal_turn = ArchivedTraceSpan(
        trace_id=TRACE_ID,
        span_id="llm",
        name="call_llm",
        start_time_unix_nano="2",
        attributes={"gen_ai.operation.name": "chat", "output.value": "let me think about tools"},
    )

    response, _, _ = extract_scoring_evidence([agent, later_internal_turn])

    assert response == "the delivered answer"


@pytest.mark.asyncio
async def test_hydrate_defers_scoring_when_trajectory_is_incomplete():
    class _Reader:
        async def find(self, **kwargs):  # noqa: ARG002
            return RunItemTraceEvidence(
                state="available",
                trace_id=TRACE_ID,
                pagination_complete=True,
                lifecycle_complete=False,
                evidence_complete=False,
                spans=[_span("agent", **{"output.value": "partial"})],
            )

    row = _row()
    await hydrate_row_from_archive(
        row,
        tenant_id="evalai",
        settings=Settings(
            trace_archive_enabled=True,
            trace_archive_score_timeout_seconds=0,
            trace_archive_deferred_score=True,
            database_url="sqlite+aiosqlite://",
        ),
        reader=_Reader(),
    )
    assert row.response == "session answer"
    assert [call.name for call in row.tool_calls] == ["session_tool"]
    assert row.output_data["response_source"] == TELEMETRY_PENDING_SOURCE
    assert row.output_data["archive_pending_reason"] == "incomplete_trajectory"
    assert row.tool_evidence_source != TELEMETRY_EVIDENCE_SOURCE
    assert row.tool_evidence_source != A2A_FALLBACK_EVIDENCE_SOURCE


def test_final_response_scope_uses_a2a_capture_instead_of_deferred_trace_wait():
    cfg = Settings(
        trace_archive_enabled=True,
        trace_archive_deferred_score=True,
        database_url="sqlite+aiosqlite://",
    )
    assert uses_a2a_capture_for_scoring(EvaluationScope.FINAL_RESPONSE) is True
    assert uses_a2a_capture_for_scoring(EvaluationScope.TOOL_INTERACTIONS) is False
    assert incomplete_archive_mode(cfg, evaluation_scope=EvaluationScope.FINAL_RESPONSE) == "fallback"
    assert incomplete_archive_mode(cfg, evaluation_scope=EvaluationScope.TOOL_INTERACTIONS) == "defer"


def test_archive_filter_preserves_retrieval_used_for_scoring():
    from proofgrove.evaluation.trace_archive import _relevant_spans

    root = _span("agent", **{"openinference.span.kind": "AGENT"})
    retriever = _span("retriever", **{
        "openinference.span.kind": "RETRIEVER",
        "retrieval.documents.0.document.content": "archived retrieval",
    }).model_copy(update={"parent_span_id": root.span_id})
    selected = _relevant_spans([root, retriever])
    assert extract_scoring_evidence(selected)[2] == ["archived retrieval"]
