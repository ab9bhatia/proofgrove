"""Evidence readiness, capture completeness, and provenance tests."""

import httpx
import pytest

from evalhub.evaluation.dataset_bridge import record_to_row
from evalhub.evaluation.enums import (
    EvaluationScope,
    EvidenceCaptureStatus,
    EvidenceCategoryStatus,
    EvidenceReadiness,
    PreRunApplicability,
    ProvenanceStatus,
    Scenario,
)
from evalhub.evaluation.models import EvaluationRow, ToolCall
from evalhub.evaluation.readiness import (
    assess_evidence_readiness,
    classify_evidence_capture,
)
from evalhub.evaluation.target.discovery import AgentSummary
from evalhub.settings import Settings


def _settings() -> Settings:
    return Settings(
        database_url="sqlite+aiosqlite://",
        pod_namespace="tenant-test",
        kagent_url="http://kagent.test",
        openai_base_url="http://gateway.test/v1",
    )


def _records() -> list[dict]:
    return [{"inputs": {"query": "q"}, "expectations": {"response": "a"}}]


def _assess_kwargs(**overrides) -> dict:
    """Default kwargs for assess_evidence_readiness(); fresh dict/list/settings per call."""

    kwargs = dict(
        response_source="baseline",
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        agent=None,
        target_model=None,
        target_endpoint=None,
        records=_records(),
        active_metric_ids=["llm.relevance"],
        scenario=Scenario.LLM_CORE,
        settings=_settings(),
    )
    kwargs.update(overrides)
    return kwargs


async def _assess(**overrides):
    return await assess_evidence_readiness(**_assess_kwargs(**overrides))


def _final_response_requirements() -> list[str]:
    return ["input", "final_output"]


def _tool_interactions_requirements() -> list[str]:
    return ["input", "final_output", "tool_calls", "tool_results"]


def _full_execution_requirements() -> list[str]:
    return [
        "input",
        "final_output",
        "tool_calls",
        "tool_results",
        "trace",
        "retrieval",
        "model_usage",
        "lifecycle_events",
    ]


@pytest.mark.asyncio
async def test_baseline_final_response_is_ready():
    result = await _assess()

    assert result.status == EvidenceReadiness.READY
    assert result.effective_evidence_requirements == ["input", "final_output"]
    assert result.resolved_provenance["status"] == "not_applicable"


@pytest.mark.asyncio
async def test_a_question_keyed_row_is_ready_and_stays_ready_at_launch():
    """Coverage and launch must read the question the same way.

    Dataset coverage accepts `question`; this read took only `query`/`input`/
    `prompt`, so a question-keyed dataset — the shape the generation and records
    APIs produce — listed as Ready and then failed with `dataset_input_missing`.
    """

    records = [{"inputs": {"question": "q", "response": "a"}, "expectations": {}}]

    result = await _assess(
        response_source="provided", records=records, active_metric_ids=["llm.coherence"]
    )

    assert result.status == EvidenceReadiness.READY


@pytest.mark.asyncio
async def test_a_stored_answer_is_not_shadowed_by_an_empty_declaration():
    """An empty expectation must not discard the answer the row actually holds.

    A dataset built on a fixed schema carries ``expectations.response`` as ""
    while the captured output sits in ``inputs.response``. Reading the first
    container that merely has the key scored every such row against an empty
    string — and readiness, capture status and the row count all still said the
    run was complete, so nothing surfaced it.
    """

    records = [
        {
            "inputs": {"query": "q", "response": "the stored answer"},
            "expectations": {"response": ""},
        }
    ]

    result = await _assess(
        response_source="provided", records=records, active_metric_ids=["llm.coherence"]
    )

    assert result.status == EvidenceReadiness.READY
    assert record_to_row(records[0], response_source="provided").response == "the stored answer"


@pytest.mark.asyncio
async def test_declared_empty_provided_response_is_ready_and_preserved():
    records = [
        {
            "inputs": {"query": "q"},
            "expectations": {"response": ""},
        }
    ]

    result = await _assess(
        response_source="provided", records=records, active_metric_ids=["llm.coherence"]
    )

    assert result.status == EvidenceReadiness.READY
    assert record_to_row(records[0], response_source="provided").response == ""


@pytest.mark.asyncio
async def test_contract_required_not_applicable_metric_blocks_setup():
    # A RAG metric is not applicable without a retrieval stage (a baseline LLM
    # source). If a contract pins it as required, setup is blocked rather than
    # silently run. (RAG evidence is not tool evidence, so this reaches the
    # applicability guard rather than the tool-evidence-unsupported check.)
    result = await _assess(
        active_metric_ids=["rag.groundedness", "llm.relevance"],
        resolved_metric_requirements=[
            {
                "metric_id": "rag.groundedness",
                "requirement": "required",
                "source": "quality_contract",
            },
            {"metric_id": "llm.relevance", "requirement": "optional"},
        ],
    )

    assert result.status == EvidenceReadiness.BLOCKED
    assert result.details[0].code == "contract_metric_not_applicable"
    assert "rag.groundedness" in result.details[0].message


@pytest.mark.asyncio
async def test_user_selected_not_applicable_metric_does_not_block_setup():
    # A metric the user explicitly selected (no contract pins it) that is known
    # not-applicable must not deadlock setup: readiness proceeds and the
    # not-applicable classification (with its reason) is surfaced instead.
    result = await _assess(
        active_metric_ids=["rag.groundedness", "llm.relevance"],
        resolved_metric_requirements=[
            {
                "metric_id": "rag.groundedness",
                "requirement": "required",
                "source": "explicit_selection",
            },
            {
                "metric_id": "llm.relevance",
                "requirement": "required",
                "source": "explicit_selection",
            },
        ],
    )

    assert result.status == EvidenceReadiness.READY
    row = next(
        item
        for item in result.metric_applicability
        if item.metric_id == "rag.groundedness"
    )
    assert row.applicability == PreRunApplicability.KNOWN_NOT_APPLICABLE
    assert row.reason


@pytest.mark.asyncio
async def test_batch_only_metric_is_rejected_before_job_creation():
    result = await _assess(active_metric_ids=["safety.violence"])

    assert result.status == EvidenceReadiness.UNSUPPORTED
    assert result.details[0].code == "metric_execution_unavailable"
    assert "batch-lane metric" in result.details[0].message


@pytest.mark.asyncio
async def test_agent_dependency_failure_is_unknown(monkeypatch):
    async def _unavailable(**kwargs):  # noqa: ARG001
        raise httpx.ConnectError("temporary outage")

    monkeypatch.setattr(
        "evalhub.evaluation.readiness.list_tenant_agents",
        _unavailable,
    )
    result = await _assess(
        response_source="agent",
        agent="tenant-test/agent",
        active_metric_ids=["agent.tool_selection"],
        scenario=Scenario.AGENTIC,
    )

    assert result.status == EvidenceReadiness.UNKNOWN
    assert result.details[0].code == "agent_discovery_unavailable"


@pytest.mark.asyncio
async def test_agent_revision_drift_blocks_worker_revalidation(monkeypatch):
    async def _agents(**kwargs):  # noqa: ARG001
        return [
            AgentSummary(
                id="tenant-test/agent",
                name="agent",
                namespace="tenant-test",
                ready=True,
                accepted=True,
                revision="revision-2",
                agent_type="Declarative",
            )
        ]

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="agent",
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        agent="tenant-test/agent",
        active_metric_ids=["agent.tool_selection"],
        scenario=Scenario.AGENTIC,
        expected_provenance={"revision": "revision-1"},
    )

    assert result.status == EvidenceReadiness.BLOCKED
    assert result.details[0].code == "target_drift"


@pytest.mark.asyncio
async def test_tool_interactions_are_not_ready_without_completion_manifest(monkeypatch):
    async def _agents(**kwargs):  # noqa: ARG001
        return [
            AgentSummary(
                id="tenant-test/agent",
                name="agent",
                namespace="tenant-test",
                ready=True,
                accepted=True,
                revision="revision-1",
                agent_type="Declarative",
            )
        ]

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="agent",
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        agent="tenant-test/agent",
        active_metric_ids=["agent.tool_selection"],
        scenario=Scenario.AGENTIC,
    )

    assert result.status == EvidenceReadiness.UNSUPPORTED
    assert result.details[0].code == "tool_capture_completion_unavailable"
    assert result.details[0].message == (
        "Tool-call capture attestation is not configured for this environment."
    )


@pytest.mark.asyncio
async def test_tool_interactions_are_ready_when_trace_archive_is_enabled(monkeypatch):
    async def _agents(**kwargs):  # noqa: ARG001
        return [
            AgentSummary(
                id="tenant-test/agent",
                name="agent",
                namespace="tenant-test",
                ready=True,
                accepted=True,
                revision="revision-1",
                agent_type="Declarative",
                tools=["search"],
            )
        ]

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="agent",
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        agent="tenant-test/agent",
        active_metric_ids=["agent.tool_selection"],
        scenario=Scenario.AGENTIC,
        settings=_settings().model_copy(update={"trace_archive_enabled": True}),
    )

    assert result.status == EvidenceReadiness.READY


@pytest.mark.asyncio
async def test_byo_tool_interactions_are_ready_when_trace_archive_is_enabled(monkeypatch):
    async def _agents(**kwargs):  # noqa: ARG001
        return [
            AgentSummary(
                id="tenant-test/agent",
                name="agent",
                namespace="tenant-test",
                ready=True,
                accepted=True,
                revision="revision-1",
                agent_type="BYO",
            )
        ]

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="agent",
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        agent="tenant-test/agent",
        active_metric_ids=["agent.tool_selection"],
        scenario=Scenario.AGENTIC,
        settings=_settings().model_copy(update={"trace_archive_enabled": True}),
    )

    assert result.status == EvidenceReadiness.READY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("metric_id", "expected_requirements"),
    [
        ("agent.tool_selection", ["input", "final_output", "tool_calls"]),
        (
            "agent.task_adherence",
            ["input", "final_output", "tool_calls", "tool_results"],
        ),
    ],
)
async def test_readiness_uses_metric_specific_evidence_requirements(
    metric_id,
    expected_requirements,
):
    result = await _assess(
        response_source="provided",
        active_metric_ids=[metric_id],
        scenario=Scenario.AGENTIC,
    )

    assert result.status == EvidenceReadiness.UNSUPPORTED
    assert result.effective_evidence_requirements == expected_requirements
    assert result.metric_evidence_requirements == {metric_id: expected_requirements[2:]}


@pytest.mark.asyncio
async def test_readiness_prefers_pinned_manifest_evidence_requirements():
    result = await _assess(
        response_source="provided",
        active_metric_ids=["agent.task_adherence"],
        scenario=Scenario.AGENTIC,
        resolved_metric_evidence_requirements={"agent.task_adherence": ["tool_calls"]},
        resolved_evidence_requirements=["input", "final_output", "tool_calls"],
    )

    assert result.status == EvidenceReadiness.UNSUPPORTED
    assert result.effective_evidence_requirements == [
        "input",
        "final_output",
        "tool_calls",
    ]
    assert result.metric_evidence_requirements == {"agent.task_adherence": ["tool_calls"]}


def test_trusted_zero_tool_events_are_complete_not_missing():
    rows = [
        EvaluationRow(
            row_id="case-1",
            query="q",
            response="a",
            from_agent=True,
            trace_unavailable=False,
            tool_evidence_completion_attested=True,
            tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_evidence_source="completion manifest",
            tool_calls=[],
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        effective_requirements=_tool_interactions_requirements(),
    )

    tool_calls = next(category for category in categories if category.category == "tool_calls")
    assert overall == EvidenceCaptureStatus.COMPLETE
    assert tool_calls.status == EvidenceCategoryStatus.CAPTURED
    assert tool_calls.record_count == 0
    assert tool_calls.completeness_attested is True


def test_missing_tool_result_is_separate_from_captured_tool_call():
    rows = [
        EvaluationRow(
            row_id="case-1",
            query="q",
            response="a",
            from_agent=True,
            trace_unavailable=False,
            tool_evidence_completion_attested=True,
            tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_calls=[
                ToolCall(name="search", output={"matches": 1}, result_captured=True),
                ToolCall(name="lookup", result_captured=False),
            ],
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        effective_requirements=_tool_interactions_requirements(),
    )

    tool_calls = next(category for category in categories if category.category == "tool_calls")
    tool_results = next(category for category in categories if category.category == "tool_results")
    assert overall == EvidenceCaptureStatus.PARTIAL
    assert tool_calls.status == EvidenceCategoryStatus.CAPTURED
    assert tool_calls.record_count == 2
    assert tool_results.status == EvidenceCategoryStatus.PARTIAL
    assert tool_results.record_count == 1
    assert tool_results.completeness_attested is False


def test_explicit_json_null_tool_result_is_captured():
    rows = [
        EvaluationRow(
            row_id="case-1",
            query="q",
            response="a",
            from_agent=True,
            trace_unavailable=False,
            tool_evidence_completion_attested=True,
            tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_calls=[ToolCall(name="delete", output=None, result_captured=True)],
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        effective_requirements=_tool_interactions_requirements(),
    )

    tool_results = next(category for category in categories if category.category == "tool_results")
    assert overall == EvidenceCaptureStatus.COMPLETE
    assert tool_results.status == EvidenceCategoryStatus.CAPTURED
    assert tool_results.record_count == 1
    assert tool_results.completeness_attested is True


def test_missing_all_tool_results_makes_overall_capture_partial():
    rows = [
        EvaluationRow(
            row_id="case-1",
            query="q",
            response="a",
            from_agent=True,
            trace_unavailable=False,
            tool_evidence_completion_attested=True,
            tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_calls=[ToolCall(name="lookup", result_captured=False)],
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        effective_requirements=_tool_interactions_requirements(),
    )

    tool_results = next(category for category in categories if category.category == "tool_results")
    assert overall == EvidenceCaptureStatus.PARTIAL
    assert tool_results.status == EvidenceCategoryStatus.NOT_CAPTURED
    assert tool_results.record_count == 0


def test_empty_session_without_completion_attestation_stays_unknown():
    rows = [
        EvaluationRow(
            row_id="case-1",
            query="q",
            response="a",
            from_agent=True,
            trace_unavailable=False,
            tool_calls=[],
            tool_evidence_provenance_status=ProvenanceStatus.SELF_REPORTED,
            tool_evidence_source="kagent session events",
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.TOOL_INTERACTIONS,
        effective_requirements=["input", "final_output", "tool_calls"],
    )

    tool_calls = next(category for category in categories if category.category == "tool_calls")
    assert overall == EvidenceCaptureStatus.PARTIAL
    assert tool_calls.status == EvidenceCategoryStatus.UNKNOWN
    assert tool_calls.completeness_attested is False
    assert tool_calls.provenance_status == ProvenanceStatus.SELF_REPORTED


def test_a_required_category_the_classifier_cannot_assess_is_reported_unknown():
    """An unexaminable requirement must never read as a satisfied one.

    The status filter reads the categories that were built, so a requirement
    with no builder used to contribute nothing at all: a full-execution run
    whose four buildable categories were captured reported COMPLETE, and the
    release gate — iterating the same list — found nothing to block on.
    """

    rows = [
        EvaluationRow(
            row_id="case-1",
            query="q",
            response="a",
            from_agent=True,
            trace_unavailable=False,
            tool_evidence_completion_attested=True,
            tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_evidence_source="otel-archive",
            tool_calls=[ToolCall(name="search", output="x", result_captured=True)],
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        effective_requirements=_full_execution_requirements(),
    )

    by_category = {category.category: category for category in categories}
    # Every required category is present, not just the ones with a builder.
    assert set(by_category) == {
        "input",
        "final_output",
        "tool_calls",
        "tool_results",
        "trace",
        "retrieval",
        "model_usage",
        "lifecycle_events",
    }
    # trace and model_usage are derived from what actually landed; only these
    # two have no derivation at all and must fall through to UNKNOWN.
    for name in ("retrieval", "lifecycle_events"):
        unassessed = by_category[name]
        assert unassessed.required is True
        assert unassessed.status == EvidenceCategoryStatus.UNKNOWN
        assert unassessed.completeness_attested is False
        assert unassessed.provenance_status == ProvenanceStatus.UNAVAILABLE

    # The four buildable categories are all captured, so the only thing keeping
    # this off COMPLETE is the honest reporting of the four that are not.
    assert overall == EvidenceCaptureStatus.PARTIAL

    # And the release gate can now see something to refuse.
    missing_required = sorted(
        category.category
        for category in categories
        if category.required and category.status != EvidenceCategoryStatus.CAPTURED
    )
    assert missing_required == ["lifecycle_events", "model_usage", "retrieval", "trace"]


def test_shallower_scopes_gain_no_extra_categories():
    """The fix must not invent requirements for depths that never had them."""

    rows = [EvaluationRow(row_id="case-1", query="q", response="a")]

    _, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        effective_requirements=_final_response_requirements(),
    )

    assert [category.category for category in categories] == ["input", "final_output"]


@pytest.mark.asyncio
async def test_full_execution_is_ready_for_a_capable_agent(monkeypatch):
    """The depth is decided by capability now, not by a blanket refusal.

    It previously returned UNSUPPORTED before any dataset, agent, readiness or
    drift check ran, so no full-execution request could reach a real validation.
    """

    async def _agents(**kwargs):  # noqa: ARG001
        return [
            AgentSummary(
                id="tenant-test/agent",
                name="agent",
                namespace="tenant-test",
                ready=True,
                accepted=True,
                revision="revision-1",
                agent_type="BYO",
            )
        ]

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="agent",
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        agent="tenant-test/agent",
        active_metric_ids=["agent.tool_selection"],
        scenario=Scenario.AGENTIC,
        settings=_settings().model_copy(update={"trace_archive_enabled": True}),
    )

    assert result.status == EvidenceReadiness.READY
    assert result.resolved_evaluation_scope == EvaluationScope.FULL_EXECUTION
    # Readiness carries the full requirement set forward, so post-run
    # classification has all eight to report on.
    assert result.effective_evidence_requirements == [
        "input",
        "final_output",
        "tool_calls",
        "tool_results",
        "trace",
        "retrieval",
        "model_usage",
        "lifecycle_events",
    ]


@pytest.mark.asyncio
async def test_full_execution_is_refused_for_a_source_that_cannot_supply_tools(monkeypatch):
    """Enabling the depth must not make it available to every source."""

    async def _agents(**kwargs):  # noqa: ARG001
        return []

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="provided",
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        active_metric_ids=["llm.coherence"],
        settings=Settings(
            database_url="sqlite+aiosqlite://",
            pod_namespace="tenant-test",
            trace_archive_enabled=True,
        ),
    )

    assert result.status == EvidenceReadiness.UNSUPPORTED
    assert result.details[0].code == "tool_evidence_unsupported"


def test_an_empty_answer_is_captured_evidence_not_missing_evidence():
    """Capture is whether the answer reached us, not whether it is any good.

    Keying this on a non-empty response conflated the two axes: a target that
    answered with nothing had been captured perfectly, but was reported as
    missing evidence. With capture feeding the verdict that turns a legitimate
    quality failure into an inconclusive run, blaming the evidence pipeline for
    the model's output and suppressing the real signal.
    """

    rows = [
        EvaluationRow(row_id="r1", query="q", response="a real answer"),
        # Invoked successfully; the target simply returned nothing.
        EvaluationRow(row_id="r2", query="q", response="", invocation_error=None),
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        effective_requirements=_final_response_requirements(),
    )

    final_output = next(c for c in categories if c.category == "final_output")
    assert final_output.status == EvidenceCategoryStatus.CAPTURED
    assert overall == EvidenceCaptureStatus.COMPLETE


@pytest.mark.parametrize(
    ("response_source", "provenance_status", "provenance_source"),
    [
        ("provided", ProvenanceStatus.SELF_REPORTED, "dataset declaration"),
        ("baseline", ProvenanceStatus.NOT_APPLICABLE, "dataset version"),
    ],
)
def test_stored_final_output_never_claims_a_target_invocation(
    response_source, provenance_status, provenance_source
):
    _, categories = classify_evidence_capture(
        [EvaluationRow(row_id="r1", query="q", response="stored answer")],
        response_source=response_source,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        effective_requirements=_final_response_requirements(),
    )

    final_output = next(c for c in categories if c.category == "final_output")
    assert final_output.status == EvidenceCategoryStatus.CAPTURED
    assert final_output.provenance_status == provenance_status
    assert final_output.provenance_source == provenance_source


def test_a_failed_invocation_is_missing_final_output():
    """The other side of it: nothing was produced, so nothing was captured."""

    rows = [
        EvaluationRow(row_id="r1", query="q", response="a real answer"),
        EvaluationRow(row_id="r2", query="q", response="", invocation_error="boom"),
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        effective_requirements=_final_response_requirements(),
    )

    final_output = next(c for c in categories if c.category == "final_output")
    assert final_output.status == EvidenceCategoryStatus.PARTIAL
    assert overall == EvidenceCaptureStatus.PARTIAL


@pytest.mark.asyncio
async def test_a_metric_requirement_promotes_the_depth_the_caller_chose(monkeypatch):
    """Evidence requirements decide the depth, not only the caller.

    A metric needing tool evidence resolves an Answer-quality request up to full
    execution, and both the requested and the resolved depth are reported so the
    caller can see it happened rather than wondering why the run went deep.
    """

    async def _agents(**kwargs):  # noqa: ARG001
        return [
            AgentSummary(
                id="tenant-test/agent",
                name="agent",
                namespace="tenant-test",
                ready=True,
                accepted=True,
                revision="revision-1",
                agent_type="BYO",
            )
        ]

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="agent",
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        requested_evaluation_scope=EvaluationScope.FINAL_RESPONSE,
        agent="tenant-test/agent",
        active_metric_ids=["agent.tool_selection"],
        scenario=Scenario.AGENTIC,
        settings=_settings().model_copy(update={"trace_archive_enabled": True}),
    )

    assert result.status == EvidenceReadiness.READY
    assert result.requested_evaluation_scope == EvaluationScope.FINAL_RESPONSE
    assert result.resolved_evaluation_scope == EvaluationScope.FULL_EXECUTION


@pytest.mark.asyncio
async def test_full_execution_is_refused_for_a_source_that_cannot_supply_tool_evidence(monkeypatch):
    """Depth availability is derived from the target, not granted by asking."""

    async def _agents(**kwargs):  # noqa: ARG001
        return []

    monkeypatch.setattr("evalhub.evaluation.readiness.list_tenant_agents", _agents)
    result = await _assess(
        response_source="provided",
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        active_metric_ids=["llm.coherence"],
        settings=Settings(database_url="sqlite+aiosqlite://", pod_namespace="tenant-test"),
    )

    assert result.status == EvidenceReadiness.UNSUPPORTED


def test_captured_but_unvouched_evidence_is_not_complete():
    """The flag the system records must be the flag it reads.

    ``completeness_attested`` was set on every category and consulted nowhere:
    overall status and the release gate both keyed on ``status`` alone, so
    evidence that merely arrived counted exactly like evidence something had
    vouched for. That is the distinction the flag exists to draw, and it is what
    makes deriving a category from what landed safe.
    """

    rows = [
        EvaluationRow(
            row_id="r1",
            query="q",
            response="a",
            from_agent=True,
            trace_unavailable=False,
            trace_span_count=360,
            tool_evidence_completion_attested=True,
            tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_calls=[ToolCall(name="search", output="x", result_captured=True)],
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        effective_requirements=["input", "final_output", "tool_calls", "tool_results", "trace"],
    )
    by_category = {category.category: category for category in categories}

    # The trace genuinely arrived — 360 spans — but no root span reaches this
    # archive, so nothing vouches it is whole.
    assert by_category["trace"].status == EvidenceCategoryStatus.CAPTURED
    assert by_category["trace"].record_count == 360
    assert by_category["trace"].completeness_attested is False

    # And that alone keeps the run off complete.
    assert overall == EvidenceCaptureStatus.PARTIAL


def test_retrieval_absent_is_not_retrieval_unexamined():
    """An agent that calls no retrieval tool has none to show.

    Reporting that as unknown invites a hunt for a capture fault that does not
    exist. The trace decides which case it is: read it and find nothing, and
    there was nothing; fail to read it, and we genuinely cannot say.
    """

    def retrieval_for(**kwargs):
        rows = [
            EvaluationRow(
                row_id="r1",
                query="q",
                response="a",
                from_agent=True,
                trace_unavailable=False,
                **kwargs,
            )
        ]
        _, categories = classify_evidence_capture(
            rows,
            evaluation_scope=EvaluationScope.FULL_EXECUTION,
            effective_requirements=["input", "final_output", "retrieval"],
        )
        return next(c for c in categories if c.category == "retrieval")

    # Trace read, nothing retrieved: expected for a non-RAG agent.
    absent = retrieval_for(trace_span_count=8)
    assert absent.status == EvidenceCategoryStatus.NOT_REQUIRED
    assert absent.provenance_status == ProvenanceStatus.NOT_APPLICABLE
    # And it is not owed: an expected absence must not hold the run off
    # complete or block a release for evidence that was never going to exist.
    assert absent.required is False

    # Trace read, retrieval present.
    present = retrieval_for(trace_span_count=8, retrieval_snippets=["a document"])
    assert present.status == EvidenceCategoryStatus.CAPTURED

    # Trace never read: genuinely unknown, not "there was none".
    unread = retrieval_for(trace_span_count=None)
    assert unread.status == EvidenceCategoryStatus.UNKNOWN


def test_model_usage_comes_from_the_invocation_not_from_summing_spans():
    """The target's own report answers a question span sums cannot.

    Nested generation spans re-report the same call, so summing them over-counts
    a wrapper and attributing to the innermost under-counts two independent
    calls -- and no convention says which span owns a call. The invocation
    reports one figure for the work it did. It is never attested: a truncated
    stream loses frames, and nothing vouches the target declared every call.
    """

    def usage_for(rows):
        _, categories = classify_evidence_capture(
            rows,
            evaluation_scope=EvaluationScope.FULL_EXECUTION,
            effective_requirements=["input", "final_output", "model_usage"],
        )
        return next(c for c in categories if c.category == "model_usage")

    def row(row_id, **kwargs):
        return EvaluationRow(row_id=row_id, query="q", response="a", **kwargs)

    reported = usage_for([row("r1", target_usage={"prompt_tokens": 888, "completion_tokens": 17})])
    assert reported.status == EvidenceCategoryStatus.CAPTURED
    assert reported.provenance_status == ProvenanceStatus.SELF_REPORTED
    assert reported.completeness_attested is False

    # Some rows reported and some did not.
    partial = usage_for(
        [row("r1", target_usage={"total_tokens": 100}), row("r2")]
    )
    assert partial.status == EvidenceCategoryStatus.PARTIAL

    # Nothing reported: whether the target does not report usage or we failed to
    # capture it is exactly what cannot be told apart.
    silent = usage_for([row("r1")])
    assert silent.status == EvidenceCategoryStatus.UNKNOWN
    assert silent.provenance_status == ProvenanceStatus.UNAVAILABLE

    # Half a pair is not a report. The scorer's reader fills the missing counter
    # with zero so a metric can still produce a number; taking that here would
    # call a synthesised total captured evidence.
    assert usage_for([row("r1", target_usage={"prompt_tokens": 888})]).status == (
        EvidenceCategoryStatus.UNKNOWN
    )
    # No real invocation spends zero tokens, so a zero is a placeholder.
    assert usage_for([row("r1", target_usage={"total_tokens": 0})]).status == (
        EvidenceCategoryStatus.UNKNOWN
    )
    assert usage_for([]).status == EvidenceCategoryStatus.UNKNOWN

    # The guarantee this category rests on, asserted rather than assumed: usage
    # the target vouched for itself must not carry a run to complete capture.
    status, _ = classify_evidence_capture(
        [
            EvaluationRow(
                row_id="r1",
                query="q",
                response="a",
                target_usage={"prompt_tokens": 888, "completion_tokens": 17},
            )
        ],
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        effective_requirements=["input", "final_output", "model_usage"],
    )
    assert status != EvidenceCaptureStatus.COMPLETE


def test_lifecycle_events_absent_from_a_read_trace_is_not_unexamined():
    """Every execution has a lifecycle, so absence here is never the target's choice.

    Unlike retrieval, which a target genuinely may not perform, a missing
    lifecycle event means we did not capture one -- provided we looked. The
    category stays owed either way; what changes is whether the report claims to
    have looked.
    """

    def lifecycle_for(**kwargs):
        rows = [EvaluationRow(row_id="r1", query="q", response="a", **kwargs)]
        _, categories = classify_evidence_capture(
            rows,
            evaluation_scope=EvaluationScope.FULL_EXECUTION,
            effective_requirements=["input", "final_output", "lifecycle_events"],
        )
        return next(c for c in categories if c.category == "lifecycle_events")

    looked = lifecycle_for(trace_span_count=16)
    assert looked.status == EvidenceCategoryStatus.NOT_CAPTURED
    # Still owed -- an absence we can account for is not an absence we can excuse.
    assert looked.required is True
    # Nothing emits lifecycle events, so nothing is ever counted or vouched for.
    assert looked.record_count == 0
    assert looked.provenance_status == ProvenanceStatus.UNAVAILABLE
    assert looked.completeness_attested is False

    unread = lifecycle_for(trace_span_count=None)
    assert unread.status == EvidenceCategoryStatus.UNKNOWN

    # One row read and one not: we did not look everywhere, so we cannot say we
    # looked and found none.
    _, categories = classify_evidence_capture(
        [
            EvaluationRow(row_id="r1", query="q", response="a", trace_span_count=16),
            EvaluationRow(row_id="r2", query="q", response="a"),
        ],
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        effective_requirements=["input", "final_output", "lifecycle_events"],
    )
    mixed = next(c for c in categories if c.category == "lifecycle_events")
    assert mixed.status == EvidenceCategoryStatus.UNKNOWN


def test_full_execution_is_complete_when_archive_and_usage_are_attested():
    """A closed archive snapshot can now produce a release-grade deep run."""

    rows = [
        EvaluationRow(
            row_id="r1",
            query="q",
            response="a",
            from_agent=True,
            trace_span_count=8,
            trace_completion_attested=True,
            lifecycle_completion_attested=True,
            target_usage={"prompt_tokens": 8, "completion_tokens": 3},
            model_usage_completion_attested=True,
            tool_evidence_completion_attested=True,
            tool_evidence_provenance_status=ProvenanceStatus.ATTESTED,
            tool_evidence_source="otel-archive",
        )
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        effective_requirements=_full_execution_requirements(),
    )

    by_category = {category.category: category for category in categories}
    assert overall == EvidenceCaptureStatus.COMPLETE
    assert by_category["trace"].completeness_attested is True
    assert by_category["model_usage"].completeness_attested is True
    assert by_category["model_usage"].provenance_status == ProvenanceStatus.SELF_REPORTED
    assert by_category["lifecycle_events"].status == EvidenceCategoryStatus.CAPTURED
    assert by_category["lifecycle_events"].completeness_attested is True
    assert by_category["retrieval"].status == EvidenceCategoryStatus.NOT_REQUIRED
    assert by_category["retrieval"].required is False


def test_full_execution_stays_partial_when_any_row_lacks_completion_attestation():
    rows = [
        EvaluationRow(
            row_id="r1",
            query="q",
            response="a",
            trace_span_count=8,
            trace_completion_attested=True,
            lifecycle_completion_attested=True,
            target_usage={"total_tokens": 11},
            model_usage_completion_attested=True,
        ),
        EvaluationRow(
            row_id="r2",
            query="q2",
            response="a2",
            trace_span_count=5,
            target_usage={"total_tokens": 7},
        ),
    ]

    overall, categories = classify_evidence_capture(
        rows,
        evaluation_scope=EvaluationScope.FULL_EXECUTION,
        effective_requirements=[
            "input",
            "final_output",
            "trace",
            "model_usage",
            "lifecycle_events",
        ],
    )

    by_category = {category.category: category for category in categories}
    assert overall == EvidenceCaptureStatus.PARTIAL
    assert by_category["trace"].completeness_attested is False
    assert by_category["model_usage"].completeness_attested is False
    assert by_category["lifecycle_events"].status == EvidenceCategoryStatus.PARTIAL


@pytest.mark.asyncio
@pytest.mark.parametrize("status,models,expected,code", [
    (200, ["gpt-5.1"], EvidenceReadiness.READY, None),
    (200, ["gpt-4.1-mini"], EvidenceReadiness.BLOCKED, "target_model_unavailable"),
    (503, [], EvidenceReadiness.BLOCKED, "llm_catalog_unavailable"),
])
async def test_tenant_gateway_readiness_checks_model_routes(monkeypatch, status, models, expected, code):
    client_type = httpx.AsyncClient
    def handler(request):
        assert str(request.url) == "http://tenant-ai-gateway:8080/v1/models"
        assert "authorization" not in request.headers
        return httpx.Response(status, json={"data": [{"id": model} for model in models]})
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs))
    cfg = _settings().model_copy(update={"openai_base_url": "http://tenant-ai-gateway:8080/v1"})
    result = await _assess(response_source="llm", target_model="gpt-5.1", settings=cfg)
    assert result.status == expected
    if code:
        assert result.details[0].code == code


@pytest.mark.asyncio
@pytest.mark.parametrize("metrics,judge,embedding,mode,frameworks,enabled,code", [
    (["llm.correctness"], "gpt-5.1", "text-embedding-3-large", "llm", True, True, None),
    (["llm.correctness"], "saved-unavailable", "text-embedding-3-large", "llm", True, True, "judge_model_unavailable"),
    (["llm.similarity"], "unused-model", "text-embedding-3-large", "llm", True, True, None),
    (["llm.similarity"], "gpt-5.1", "missing-embedding", "llm", True, True, "embedding_model_unavailable"),
    (["llm.similarity"], "gpt-5.1", "", "llm", True, True, "embedding_model_missing"),
    (["llm.similarity"], "saved-unavailable", "unused-model", "llm", False, True, "judge_model_unavailable"),
    (["llm.correctness"], "unused-model", "unused-model", "mock", True, True, None),
    (["llm.correctness"], "unused-model", "unused-model", "llm", True, False, None),
    (["nlp.bleu"], "unused-model", "unused-model", "llm", True, True, None),
])
async def test_tenant_scoring_model_preflight(monkeypatch, metrics, judge, embedding, mode, frameworks, enabled, code):
    calls = []
    client_type = httpx.AsyncClient

    def handler(request):
        calls.append(str(request.url))
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json={"data": [{"id": "gpt-5.1"}, {"id": "text-embedding-3-large"}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs))
    cfg = _settings().model_copy(update={
        "openai_base_url": "http://tenant-ai-gateway:8080/v1",
        "openai_api_key": "tenant-gateway", "judge_mode": mode,
        "judge_model": "gpt-5.1", "judge_embedding_model": embedding,
        "judge_use_frameworks": frameworks,
    })
    result = await _assess(
        response_source="provided",
        records=[{"inputs": {"query": "q", "response": "a"}, "expectations": {"expected_response": "a"}}],
        active_metric_ids=metrics, settings=cfg,
        judge_model=judge, enable_llm_judge=enabled,
    )
    assert result.status == (EvidenceReadiness.BLOCKED if code else EvidenceReadiness.READY)
    if code:
        assert result.details[0].code == code
    assert len(calls) <= 1


@pytest.mark.asyncio
async def test_target_and_scorers_share_one_catalogue_read(monkeypatch):
    calls = []
    client_type = httpx.AsyncClient

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, json={"data": [{"id": "gpt-5.1"}, {"id": "text-embedding-3-large"}]})

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs))
    cfg = _settings().model_copy(update={"openai_base_url": "http://tenant-ai-gateway:8080/v1", "openai_api_key": "tenant-gateway", "judge_model": "gpt-5.1"})
    result = await _assess(
        response_source="llm", target_model="gpt-5.1",
        records=[{"inputs": {"query": "q"}, "expectations": {"expected_response": "a"}}],
        active_metric_ids=["llm.correctness", "llm.similarity"], settings=cfg,
    )
    assert result.status == EvidenceReadiness.READY
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_inapplicable_metrics_do_not_require_model_routes(monkeypatch):
    def unexpected_client(**kwargs):
        pytest.fail("An inapplicable metric must not read the model catalogue")

    monkeypatch.setattr(httpx, "AsyncClient", unexpected_client)
    result = await _assess(
        response_source="provided",
        records=[{"inputs": {"query": "q", "response": "a"}}],
        active_metric_ids=["llm.correctness", "llm.similarity"],
        settings=_settings().model_copy(update={
            "openai_base_url": "http://tenant-ai-gateway:8080/v1",
            "openai_api_key": "tenant-gateway", "judge_mode": "llm",
            "judge_model": "missing-judge", "judge_embedding_model": "missing-embedding",
        }),
    )
    assert result.status == EvidenceReadiness.READY


@pytest.mark.parametrize("absent_trace_complete, expected_status", [(True, EvidenceCaptureStatus.COMPLETE), (False, EvidenceCaptureStatus.PARTIAL)])
def test_mixed_retrieval_rows_count_attested_absence_as_complete(absent_trace_complete, expected_status):
    rows = [
        EvaluationRow(row_id="retrieved", query="q", response="a", retrieval_snippets=["document"], trace_span_count=2, trace_completion_attested=True),
        EvaluationRow(row_id="no-retrieval", query="q", response="a", trace_span_count=2, trace_completion_attested=absent_trace_complete),
    ]
    status, categories = classify_evidence_capture(
        rows, response_source="agent", evaluation_scope=EvaluationScope.FULL_EXECUTION,
        effective_requirements=["input", "final_output", "retrieval", "trace"],
    )
    assert status == expected_status
    retrieval = next(category for category in categories if category.category == "retrieval")
    assert retrieval.record_count == 1
    assert retrieval.status == (EvidenceCategoryStatus.CAPTURED if absent_trace_complete else EvidenceCategoryStatus.PARTIAL)
