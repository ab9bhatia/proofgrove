"""Tests for agent-row execution failure handling and metric resolution."""

import json
import re

import httpx
import pytest
import respx

from proofgrove.evaluation import run_service
from proofgrove.evaluation.enums import EvaluationScope, Scenario
from proofgrove.evaluation.models import EvaluationRow, ToolCall
from proofgrove.evaluation.target import agent_runner
from proofgrove.evaluation.target.a2a_client import AgentInvocation, AgentInvocationError
from proofgrove.evaluation.target.agent_runner import AgentRunOutput, _filter_excluded, run_agent_target
from proofgrove.settings import Settings


def test_filter_excluded_drops_memory_tools_case_insensitive():
    calls = [ToolCall(name="search"), ToolCall(name="Memory_Search"), ToolCall(name="memory_context")]
    kept = _filter_excluded(calls, ["memory_search", "memory_context"])
    assert [c.name for c in kept] == ["search"]


def test_filter_excluded_noop_when_empty():
    calls = [ToolCall(name="search")]
    assert _filter_excluded(calls, []) == calls


@pytest.mark.asyncio
async def test_run_agent_target_excludes_memory_tool_calls(monkeypatch):
    async def _fake_invoke(**kwargs):  # noqa: ARG001
        return AgentInvocation(
            text="AAPL revenue is $383B",
            invocation_id="invocation-1",
            trace_id="0123456789abcdef0123456789abcdef",
            context_id=None,
            usage={"total_tokens": 42},
            tool_calls=[
                ToolCall(name="search", args={"query": "AAPL"}, output="{...}"),
                ToolCall(name="memory_search", args={}, output="recalled"),
            ],
        )

    monkeypatch.setattr(agent_runner, "invoke_agent", _fake_invoke)

    out = await run_agent_target(
        settings=Settings(pod_namespace="tenant-evalai"),
        target_endpoint="tenant-evalai/kensho-grounding",
        query="AAPL revenue?",
    )
    assert [c.name for c in out.tool_calls] == ["search"]
    assert out.trace_unavailable is False
    assert out.invocation_id == "invocation-1"
    assert out.trace_id == "0123456789abcdef0123456789abcdef"
    assert out.context_id is None
    assert out.target_usage == {"total_tokens": 42}


@pytest.mark.asyncio
async def test_run_agent_target_rejects_a_foreign_tenant_namespace(monkeypatch):
    """A ``<namespace>/<name>`` target_endpoint naming ANOTHER tenant's
    namespace must be rejected before kagent is ever called.

    ``target_endpoint`` is a tenant-controlled experiment field and Proofgrove
    is deployed one instance per tenant — a mismatched namespace would have
    this service invoke a different tenant's agent.
    """

    async def _must_not_invoke(**kwargs):  # noqa: ARG001
        raise AssertionError("invoke_agent must not be called for a foreign namespace")

    monkeypatch.setattr(agent_runner, "invoke_agent", _must_not_invoke)

    with pytest.raises(AgentInvocationError, match="does not match this tenant's namespace"):
        await run_agent_target(
            settings=Settings(pod_namespace="tenant-evalai"),
            target_endpoint="tenant-other/kensho-grounding",
            query="AAPL revenue?",
        )


@pytest.mark.asyncio
async def test_run_agent_target_defaults_bare_agent_to_deployment_namespace(monkeypatch):
    """Only explicit Kubernetes namespace references or a bare name are accepted."""

    async def _fake_invoke(**kwargs):  # noqa: ARG001
        return AgentInvocation(text="ok", invocation_id="invocation-2", trace_id="0" * 32, context_id=None)

    monkeypatch.setattr(agent_runner, "invoke_agent", _fake_invoke)

    out = await run_agent_target(
        settings=Settings(pod_namespace="tenant-evalai"),
        target_endpoint="kensho-grounding",
        query="AAPL revenue?",
    )
    assert out.invocation_id == "invocation-2"


@pytest.mark.asyncio
async def test_run_agent_target_externalizes_large_session_tool_result(monkeypatch):
    async def _fake_invoke(**kwargs):  # noqa: ARG001
        return AgentInvocation(
            text="The final answer remains available.",
            invocation_id="invocation-large",
            context_id="session-large",
        )

    async def _fake_session(**kwargs):  # noqa: ARG001
        return [ToolCall(name="document_search", output="x" * 150_000)]

    monkeypatch.setattr(agent_runner, "invoke_agent", _fake_invoke)
    monkeypatch.setattr(agent_runner, "fetch_session_tool_calls", _fake_session)

    out = await run_agent_target(
        settings=Settings(
            pod_namespace="tenant-evalai",
            agent_max_inline_tool_result_bytes=128 * 1024,
        ),
        target_endpoint="tenant-evalai/document-agent",
        query="find it",
    )

    assert out.response == "The final answer remains available."
    assert len(out.tool_result_artifacts) == 1
    assert out.tool_result_artifacts[0].tool_name == "document_search"
    assert out.tool_calls[0].output["artifact_ref"] == out.tool_result_artifacts[0].artifact_ref


@pytest.mark.asyncio
async def test_run_rows_continue_on_output_too_large(monkeypatch):
    from proofgrove.evaluation.target.a2a_client import AgentOutputTooLargeError

    seen: list[str] = []

    async def _fake_run(*, query, invocation_id, **kwargs):  # noqa: ARG001
        seen.append(query)
        if query == "huge":
            raise AgentOutputTooLargeError(
                limit_bytes=1_048_576,
                received_bytes=1_048_612,
                partial_text="partial answer so far",
                last_event_type="status",
                frames_collected=3,
            )
        return AgentRunOutput(
            response="answer",
            invocation_id=invocation_id,
            trace_id="fedcba9876543210fedcba9876543210",
            latency_seconds=0.1,
        )

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    rows = [
        EvaluationRow(row_id="one", query="ok", response="", from_agent=True),
        EvaluationRow(row_id="two", query="huge", response="", from_agent=True),
        EvaluationRow(row_id="three", query="also-ok", response="", from_agent=True),
    ]

    await run_service._run_agent_rows(rows, agent_ref="tenant/agent")

    assert set(seen) == {"ok", "huge", "also-ok"}
    assert rows[0].response == "answer"
    assert rows[0].invocation_error is None
    assert rows[0].trace_id == "fedcba9876543210fedcba9876543210"
    assert rows[1].invocation_error.startswith("AGENT_OUTPUT_TOO_LARGE")
    assert rows[1].tags.get("error_type") == "AGENT_OUTPUT_TOO_LARGE"
    assert rows[1].output_data["error_type"] == "AGENT_OUTPUT_TOO_LARGE"
    assert rows[1].output_data["retryable"] is False
    assert rows[1].output_data["partial_output_available"] is True
    assert rows[1].response == "partial answer so far"
    assert rows[2].response == "answer"
    assert run_service.is_output_too_large_row(rows[1]) is True
    assert run_service.is_output_too_large_row(rows[0]) is False


@pytest.mark.asyncio
async def test_run_agent_rows_resolves_an_external_target_once_for_the_whole_fan_out(monkeypatch):
    """A multi-row run against one external target must resolve it ONCE, not
    once per row — the target is identical across every row in the run, and
    re-resolving per row opens one redundant DB session per concurrent row.
    """
    from proofgrove.platform.contracts import TargetType, TargetVersion

    resolve_calls = 0
    target = TargetVersion(
        target_id="t1",
        project_id="p1",
        tenant_id="tenant-evalai",
        name="byo-agent",
        version="1.0.0",
        endpoint="https://example.invalid/agent",
        target_type=TargetType.AGENT,
        configuration={"agent_card": {}},
    )

    async def _fake_resolve(reference, settings):  # noqa: ARG001
        nonlocal resolve_calls
        resolve_calls += 1
        return target

    seen_targets: list[object] = []

    async def _fake_run(*, query, invocation_id, resolved_external_target=None, **kwargs):  # noqa: ARG001
        seen_targets.append(resolved_external_target)
        return AgentRunOutput(response="ok", invocation_id=invocation_id, latency_seconds=0.01)

    monkeypatch.setattr(run_service, "resolve_external_target", _fake_resolve)
    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)

    rows = [
        EvaluationRow(row_id="one", query="q1", response="", from_agent=True),
        EvaluationRow(row_id="two", query="q2", response="", from_agent=True),
        EvaluationRow(row_id="three", query="q3", response="", from_agent=True),
    ]
    await run_service._run_agent_rows(rows, agent_ref="external:t1")

    assert resolve_calls == 1
    assert seen_targets == [target, target, target]


@pytest.mark.asyncio
async def test_run_rows_abort_on_technical_invocation_error(monkeypatch):
    seen_invocations: list[str] = []

    async def _fake_run(*, query, invocation_id, **kwargs):  # noqa: ARG001
        seen_invocations.append(invocation_id)
        if query == "fails":
            raise AgentInvocationError("terminal target error")
        return AgentRunOutput(
            response="answer",
            invocation_id=invocation_id,
            context_id=f"session-{query}",
            latency_seconds=0.25,
            target_usage={"total_tokens": 12},
            tool_calls=[
                ToolCall(
                    name="lookup",
                    args={"query": query},
                    output={"documents": [{"id": 7}]},
                )
            ],
        )

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    rows = [
        EvaluationRow(row_id="one", query="works", response="", from_agent=True),
        EvaluationRow(row_id="two", query="fails", response="", from_agent=True),
    ]

    with pytest.raises(AgentInvocationError, match="Failed to retrieve agent output"):
        await run_service._run_agent_rows(rows, agent_ref="tenant/agent")

    assert rows[0].response == "answer"
    assert rows[1].invocation_error == "terminal target error"


@respx.mock
@pytest.mark.asyncio
async def test_invoke_agent_raises_output_too_large():
    from proofgrove.evaluation.target.a2a_client import AgentOutputTooLargeError, invoke_agent

    # First small frame, then a huge one that crosses the budget.
    small = (
        '{"result":{"kind":"status-update","status":{"message":{"role":"assistant",'
        '"parts":[{"kind":"text","text":"start"}]}}}}'
    )
    huge = "x" * 200
    body = (f"data: {small}\n\ndata: {huge}\n\n").encode()
    respx.post("http://kagent:8083/api/a2a/tenant-evalai/geo/").mock(
        return_value=httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=body
        )
    )
    # First frame fits; second frame pushes the cumulative stream over budget.
    budget = len(small) + 50
    with pytest.raises(AgentOutputTooLargeError) as exc_info:
        await invoke_agent(
            kagent_url="http://kagent:8083",
            namespace="tenant-evalai",
            agent_name="geo",
            prompt="hi",
            max_response_bytes=budget,
        )
    err = exc_info.value
    assert err.limit_bytes == budget
    assert err.received_bytes > budget
    assert err.retryable is False
    assert "AGENT_OUTPUT_TOO_LARGE" in str(err)
    assert err.partial_text == "start"
    assert err.frames_collected >= 1


@pytest.mark.asyncio
async def test_run_rows_abort_on_empty_agent_response(monkeypatch):
    async def _fake_run(**kwargs):  # noqa: ARG001
        return AgentRunOutput(response="   ", invocation_id="inv-1", latency_seconds=0.1)

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    rows = [EvaluationRow(row_id="empty", query="q", response="", from_agent=True)]

    with pytest.raises(AgentInvocationError, match="empty response"):
        await run_service._run_agent_rows(rows, agent_ref="tenant/agent")


@pytest.mark.asyncio
async def test_run_rows_abort_on_agent_error_apology(monkeypatch):
    apology = (
        "I encountered an error while attempting to retrieve Apple's FY2023 revenue data. "
        "Would you like me to try again or assist you with another request?"
    )

    async def _fake_run(**kwargs):  # noqa: ARG001
        return AgentRunOutput(
            response=apology,
            invocation_id="inv-err",
            latency_seconds=0.2,
        )

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    rows = [EvaluationRow(row_id="apple", query="Apple FY2023 revenue?", response="", from_agent=True)]

    with pytest.raises(AgentInvocationError, match=re.escape(apology)):
        await run_service._run_agent_rows(rows, agent_ref="tenant/agent")


@pytest.mark.asyncio
async def test_run_rows_abort_with_exact_tool_integration_error(monkeypatch):
    integration_error = "MCP grounding-alpha returned HTTP 401: refresh token rejected"

    async def _fake_run(**kwargs):  # noqa: ARG001
        return AgentRunOutput(
            response=(
                "I encountered an error while attempting to retrieve Apple's FY2023 revenue data. "
                "Would you like me to try again or assist you with another request?"
            ),
            invocation_id="inv-err",
            latency_seconds=0.2,
            tool_calls=[
                ToolCall(
                    name="search",
                    args={"query": "Apple FY2023 revenue"},
                    output={"status": "error", "error": integration_error},
                )
            ],
        )

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    rows = [EvaluationRow(row_id="apple", query="Apple FY2023 revenue?", response="", from_agent=True)]

    with pytest.raises(AgentInvocationError, match=re.escape(integration_error)):
        await run_service._run_agent_rows(rows, agent_ref="tenant/agent")


def test_technical_failure_reason_uses_exact_agent_text():
    apology = (
        "I encountered an error while attempting to retrieve Apple's FY2023 revenue data. "
        "Would you like me to try again or assist you with another request?"
    )
    assert run_service.technical_failure_reason(apology) == apology


def test_technical_failure_reason_prefers_exact_tool_error():
    apology = "I encountered an error while attempting to retrieve Apple's FY2023 revenue data."
    tool_error = "kensho oauth2/refresh rejected refresh_token"
    reason = run_service.technical_failure_reason(
        apology,
        [ToolCall(name="search", args={}, output={"error": tool_error, "status": "error"})],
    )
    assert reason == tool_error


def test_technical_failure_reason_allows_normal_answers():
    assert (
        run_service.technical_failure_reason(
            "Apple's FY2023 revenue was $383.3 billion according to its 10-K filing."
        )
        is None
    )


def test_resolve_active_metrics_strips_unattached_quality_contracts():
    resolved = run_service.resolve_active_metrics(
        ["agent.task_adherence", "quality.task_completion", "llm.relevance"],
        quality_contract_ids=[],
        scenario=Scenario.AGENTIC,
    )
    assert resolved == ["agent.task_adherence", "llm.relevance"]


def test_resolve_active_metrics_includes_attached_quality_contracts():
    resolved = run_service.resolve_active_metrics(
        ["agent.task_adherence"],
        quality_contract_ids=["qc_tpl_task_completion"],
        scenario=Scenario.AGENTIC,
    )
    assert resolved == ["agent.task_adherence", "quality.task_completion"]


@pytest.mark.asyncio
async def test_run_agent_row_scores_from_archived_spans_not_session(monkeypatch):
    from proofgrove.evaluation.models import ArchivedTraceSpan, RunItemTraceEvidence
    from proofgrove.evaluation.trace_hydrator import TELEMETRY_EVIDENCE_SOURCE

    async def _fake_run(*, query, invocation_id, **kwargs):  # noqa: ARG001
        return AgentRunOutput(
            response="session answer",
            invocation_id=invocation_id,
            trace_id="0123456789abcdef0123456789abcdef",
            latency_seconds=0.1,
            tool_calls=[ToolCall(name="session_tool", output="from session")],
        )

    class _FakeReader:
        seen: dict = {}

        async def find(self, **kwargs):
            _FakeReader.seen = kwargs
            return RunItemTraceEvidence(
                state="available",
                trace_id="0123456789abcdef0123456789abcdef",
                pagination_complete=True,
                lifecycle_complete=True,
                evidence_complete=True,
                spans=[
                    ArchivedTraceSpan(
                        trace_id="0123456789abcdef0123456789abcdef",
                        span_id="1",
                        name="agent",
                        attributes={
                            "openinference.span.kind": "AGENT",
                            "output.value": "archive answer",
                        },
                    ),
                    ArchivedTraceSpan(
                        trace_id="0123456789abcdef0123456789abcdef",
                        span_id="2",
                        name="search",
                        attributes={
                            "openinference.span.kind": "TOOL",
                            "tool.name": "search",
                            "output.value": "from archive",
                        },
                    ),
                ],
            )

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    monkeypatch.setattr(run_service.settings, "trace_archive_enabled", True)
    monkeypatch.setattr(run_service.settings, "trace_archive_score_timeout_seconds", 0.0)
    monkeypatch.setattr(run_service.settings, "trace_archive_completion_min_identical_observations", 1)

    rows = [EvaluationRow(row_id="one", query="q", response="", from_agent=True)]
    await run_service._run_agent_rows(
        rows,
        agent_ref="tenant/agent",
        tenant_id="tenant-evalai",
        archive_reader=_FakeReader(),
    )

    assert _FakeReader.seen["tenant"] == "evalai"

    assert rows[0].response == "archive answer"
    assert [call.name for call in rows[0].tool_calls] == ["search"]
    assert rows[0].tool_calls[0].output == "from archive"
    assert rows[0].tool_evidence_source == TELEMETRY_EVIDENCE_SOURCE
    assert rows[0].tool_evidence_completion_attested is True
    assert rows[0].trace_unavailable is False


@pytest.mark.asyncio
async def test_run_agent_row_falls_back_to_session_tools_when_archive_missing(monkeypatch):
    from proofgrove.evaluation.models import RunItemTraceEvidence
    from proofgrove.evaluation.trace_hydrator import A2A_FALLBACK_EVIDENCE_SOURCE

    async def _fake_run(*, query, invocation_id, **kwargs):  # noqa: ARG001
        return AgentRunOutput(
            response="session answer",
            invocation_id=invocation_id,
            trace_id="0123456789abcdef0123456789abcdef",
            latency_seconds=0.1,
            tool_calls=[ToolCall(name="session_tool", output="from session")],
        )

    class _FakeReader:
        async def find(self, **kwargs):  # noqa: ARG002
            return RunItemTraceEvidence(
                state="pending",
                trace_id="0123456789abcdef0123456789abcdef",
            )

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    monkeypatch.setattr(run_service.settings, "trace_archive_enabled", True)
    monkeypatch.setattr(run_service.settings, "trace_archive_score_timeout_seconds", 0.0)
    monkeypatch.setattr(run_service.settings, "trace_archive_deferred_score", False)
    monkeypatch.setattr(run_service.settings, "trace_archive_score_fallback_to_capture", True)

    rows = [EvaluationRow(row_id="one", query="q", response="", from_agent=True)]
    await run_service._run_agent_rows(
        rows,
        agent_ref="tenant/agent",
        tenant_id="evalai",
        archive_reader=_FakeReader(),
    )

    assert rows[0].response == "session answer"
    assert [call.name for call in rows[0].tool_calls] == ["session_tool"]
    assert rows[0].trace_unavailable is False
    assert rows[0].tool_evidence_completion_attested is False
    assert rows[0].tool_evidence_source == A2A_FALLBACK_EVIDENCE_SOURCE


@pytest.mark.asyncio
async def test_run_agent_row_final_response_scores_a2a_without_waiting_on_archive(monkeypatch):
    from proofgrove.evaluation.trace_hydrator import A2A_FALLBACK_EVIDENCE_SOURCE

    async def _fake_run(*, query, invocation_id, **kwargs):  # noqa: ARG001
        return AgentRunOutput(
            response="session answer",
            invocation_id=invocation_id,
            trace_id="0123456789abcdef0123456789abcdef",
            latency_seconds=0.1,
            tool_calls=[ToolCall(name="session_tool", output="from session")],
        )

    class _FakeReader:
        called = False

        async def find(self, **kwargs):  # noqa: ARG002
            _FakeReader.called = True
            raise AssertionError("final-response scoring must not wait on the archive")

    monkeypatch.setattr(run_service, "run_agent_target", _fake_run)
    monkeypatch.setattr(run_service.settings, "trace_archive_enabled", True)

    rows = [EvaluationRow(row_id="one", query="q", response="", from_agent=True)]
    await run_service._run_agent_rows(
        rows,
        agent_ref="tenant/agent",
        tenant_id="evalai",
        archive_reader=_FakeReader(),
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
    )

    assert _FakeReader.called is False
    assert rows[0].response == "session answer"
    assert rows[0].context == []
    assert rows[0].output_data["response_source"] == A2A_FALLBACK_EVIDENCE_SOURCE
    assert rows[0].output_data["archive_fallback_reason"] == "final_response_scope"
    assert rows[0].tool_evidence_source == A2A_FALLBACK_EVIDENCE_SOURCE


def test_resolve_active_metrics_none_without_contracts_uses_scenario_defaults():
    assert (
        run_service.resolve_active_metrics(None, quality_contract_ids=[], scenario=Scenario.AGENTIC)
        is None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("foreign_session", [False, True])
@respx.mock
async def test_kagent_session_is_bound_to_fresh_invocation_identity(foreign_session):
    users = []
    def invoke(request):
        user = request.headers["X-User-ID"]
        assert user.startswith("proofgrove:tenant-evalai:")
        users.append(user)
        frame = {"result": {"contextId": "session-safe", "artifact": {"parts": [{"kind": "text", "text": "answer"}]}}}
        return httpx.Response(200, text="data: " + json.dumps(frame) + "\n\n", headers={"Content-Type": "text/event-stream"})
    def fetch(request):
        assert request.headers["X-User-ID"] == users[-1]
        assert request.url.params["user_id"] == users[-1]
        return httpx.Response(200, json={"data": {"session": {
            "id": "session-safe", "user_id": "foreign" if foreign_session else users[-1], "agent_id": "tenant_evalai__NS__my_agent",
        }, "events": []}})
    respx.post("http://kagent/api/a2a/tenant-evalai/my-agent/").mock(side_effect=invoke)
    respx.get("http://kagent/api/sessions/session-safe").mock(side_effect=fetch)
    for _ in range(2):
        result = await run_agent_target(settings=Settings(kagent_url="http://kagent", pod_namespace="tenant-evalai"), target_endpoint="tenant-evalai/my-agent", query="synthetic")
        assert result.response == "answer"
        assert result.trace_unavailable is foreign_session
    assert len(set(users)) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("namespace, target", [("tenant-foo", "foo/agent"), ("tenant-tenant-foo", "tenant-foo/agent")])
async def test_agent_namespace_never_uses_tenant_aliases(monkeypatch, namespace, target):
    from proofgrove.settings import settings as global_settings

    monkeypatch.setattr(global_settings, "pod_namespace", namespace)
    async def forbidden(**kwargs):
        raise AssertionError("cross-namespace reference reached kagent")
    monkeypatch.setattr(agent_runner, "invoke_agent", forbidden)
    with pytest.raises(AgentInvocationError, match="does not match"):
        await run_agent_target(settings=Settings(pod_namespace=namespace), target_endpoint=target, query="synthetic")


@pytest.mark.asyncio
@pytest.mark.parametrize("integration_failure", [False, True])
async def test_agent_failure_logs_omit_private_evidence(monkeypatch, caplog, integration_failure):
    private = "MCP HTTP 500: private customer diagnostic"

    async def fail(**kwargs):
        if not integration_failure:
            raise AgentInvocationError(private)
        return AgentRunOutput(
            response="I encountered an error while attempting the request.",
            invocation_id="inv-private", latency_seconds=0.1,
            tool_calls=[ToolCall(name="search", output={"status": "error", "error": private})],
        )

    monkeypatch.setattr(run_service, "run_agent_target", fail)
    row = EvaluationRow(row_id="r-private", query="query", response="")
    with pytest.raises(AgentInvocationError, match=private):
        await run_service._run_agent_row(row, agent_ref="tenant/agent")
    assert row.invocation_error == private
    assert caplog.records
    assert private not in caplog.text
