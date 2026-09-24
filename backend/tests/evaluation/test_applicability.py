"""Task 2 — pre-run metric applicability classifier.

Applicability is a dimension distinct from requirement and readiness. The
classifier decides, before the target runs, whether a metric is
known-applicable, potentially-applicable, or known-not-applicable given the
target kind/capability and the dataset — WITHOUT inventing runtime evidence.
"""

from __future__ import annotations

from evalhub.evaluation.enums import PreRunApplicability, Scenario
from evalhub.evaluation.readiness import _dataset_has_reference, classify_pre_run_applicability
from evalhub.evaluation.scenario_router import select_metrics


def _metric(metric_id: str):
    (metric,) = select_metrics(Scenario.AGENTIC, metric_ids=[metric_id]) or select_metrics(
        Scenario.RAG, metric_ids=[metric_id]
    ) or select_metrics(Scenario.LLM_CORE, metric_ids=[metric_id])
    return metric


def _by_id(results):
    return {row.metric_id: row.applicability for row in results}


TOOL = "agent.tool_call_accuracy"
LIFECYCLE = "agent.task_adherence"
RAG = "rag.groundedness"
REF = "llm.correctness"  # requires_ground_truth


def test_declarative_agent_zero_tools_makes_tool_metrics_not_applicable():
    metrics = [_metric(TOOL), _metric(LIFECYCLE)]
    out = _by_id(
        classify_pre_run_applicability(
            metrics,
            response_source="agent",
            scenario=Scenario.AGENTIC,
            has_reference=True,
            agent_tools=[],
            agent_type="Declarative",
        )
    )
    assert out[TOOL] == PreRunApplicability.KNOWN_NOT_APPLICABLE
    # A no-tool decision must not spill onto lifecycle metrics.
    assert out[LIFECYCLE] == PreRunApplicability.POTENTIALLY_APPLICABLE


def test_declarative_agent_with_tools_keeps_tool_metrics_potential():
    out = _by_id(
        classify_pre_run_applicability(
            [_metric(TOOL)],
            response_source="agent",
            scenario=Scenario.AGENTIC,
            has_reference=True,
            agent_tools=["search"],
            agent_type="Declarative",
        )
    )
    assert out[TOOL] == PreRunApplicability.POTENTIALLY_APPLICABLE


def test_byo_agent_unknown_capability_is_not_marked_not_applicable():
    out = _by_id(
        classify_pre_run_applicability(
            [_metric(TOOL)],
            response_source="agent",
            scenario=Scenario.AGENTIC,
            has_reference=True,
            agent_tools=None,  # BYO agents do not declare tools
            agent_type="BYO",
        )
    )
    assert out[TOOL] == PreRunApplicability.POTENTIALLY_APPLICABLE


def test_non_agent_target_makes_agent_metrics_not_applicable():
    out = _by_id(
        classify_pre_run_applicability(
            [_metric(TOOL), _metric(LIFECYCLE)],
            response_source="llm",
            scenario=Scenario.LLM_CORE,
            has_reference=True,
            agent_tools=None,
            agent_type=None,
        )
    )
    assert out[TOOL] == PreRunApplicability.KNOWN_NOT_APPLICABLE
    assert out[LIFECYCLE] == PreRunApplicability.KNOWN_NOT_APPLICABLE


def test_rag_metrics_without_retrieval_stage_are_not_applicable():
    out = _by_id(
        classify_pre_run_applicability(
            [_metric(RAG)],
            response_source="llm",
            scenario=Scenario.LLM_CORE,
            has_reference=True,
            agent_tools=None,
            agent_type=None,
        )
    )
    assert out[RAG] == PreRunApplicability.KNOWN_NOT_APPLICABLE


def test_rag_metrics_with_retrieval_stage_stay_potential():
    out = _by_id(
        classify_pre_run_applicability(
            [_metric(RAG)],
            response_source="llm",
            scenario=Scenario.RAG,
            has_reference=True,
            agent_tools=None,
            agent_type=None,
        )
    )
    assert out[RAG] == PreRunApplicability.POTENTIALLY_APPLICABLE


def test_reference_metric_without_dataset_reference_is_not_applicable():
    out = _by_id(
        classify_pre_run_applicability(
            [_metric(REF)],
            response_source="llm",
            scenario=Scenario.LLM_CORE,
            has_reference=False,
            agent_tools=None,
            agent_type=None,
        )
    )
    assert out[REF] == PreRunApplicability.KNOWN_NOT_APPLICABLE


def test_reference_metric_with_dataset_reference_stays_potential():
    out = _by_id(
        classify_pre_run_applicability(
            [_metric(REF)],
            response_source="llm",
            scenario=Scenario.LLM_CORE,
            has_reference=True,
            agent_tools=None,
            agent_type=None,
        )
    )
    assert out[REF] == PreRunApplicability.POTENTIALLY_APPLICABLE


def test_rag_ground_truth_metric_without_reference_is_not_applicable():
    # rag.document_recall needs a reference; a retrieval stage alone is not enough.
    out = _by_id(
        classify_pre_run_applicability(
            [_metric("rag.document_recall")],
            response_source="llm",
            scenario=Scenario.RAG,  # retrieval present, but no reference
            has_reference=False,
            agent_tools=None,
            agent_type=None,
        )
    )
    assert out["rag.document_recall"] == PreRunApplicability.KNOWN_NOT_APPLICABLE


def test_dataset_reference_detection_matches_bridge_keys():
    # Real record shapes: reference lives under `expectations`, and the accepted
    # keys are the dataset->row bridge's expected-answer keys. Empty values do
    # not count.
    assert _dataset_has_reference([{"expectations": {"expected_response": "x"}}]) is True
    assert _dataset_has_reference([{"expectations": {"expected_answer": "x"}}]) is True
    assert _dataset_has_reference([{"expectations": {"answer": "x"}}]) is True
    assert _dataset_has_reference([{"expectations": {"answer": ""}}]) is False
    assert _dataset_has_reference([{"inputs": {"query": "q"}}]) is False


def test_every_metric_gets_a_reason():
    results = classify_pre_run_applicability(
        [_metric(TOOL), _metric(LIFECYCLE), _metric(RAG), _metric(REF)],
        response_source="agent",
        scenario=Scenario.AGENTIC,
        has_reference=True,
        agent_tools=[],
        agent_type="Declarative",
    )
    assert all(row.reason for row in results)
