"""Tests for scenario router."""

from evalhub.evaluation.enums import Scenario
from evalhub.evaluation.metrics import METRIC_CATALOG
from evalhub.evaluation.scenario_router import select_kpis, select_metrics


def test_rag_metrics_include_cross_cutting():
    metrics = select_metrics(Scenario.RAG, has_ground_truth=True)
    ids = {m.metric_id for m in metrics}
    assert "rag.groundedness" in ids
    assert "safety.general" in ids
    assert "llm.guideline_adherence" in ids
    assert "ops.latency" in ids
    # The token total and the two halves it is made of are selected together.
    # These were opt-in while an operational KPI existed that they could have
    # reweighted; that KPI is gone, no remaining KPI composes them, and they
    # read the same reported usage the total already reads.
    assert "ops.total_token_count" in ids
    assert "ops.input_token_count" in ids
    assert "ops.output_token_count" in ids


def test_without_ground_truth_excludes_gt_metrics():
    metrics = select_metrics(Scenario.RAG, has_ground_truth=False)
    ids = {m.metric_id for m in metrics}
    assert "llm.correctness" not in ids
    assert "rag.document_recall" not in ids


def test_agentic_kpis():
    kpis = select_kpis(Scenario.AGENTIC)
    kpi_ids = {k.kpi_id for k in kpis}
    assert "kpi.agent_effectiveness" in kpi_ids
    assert "kpi.safety_trust" in kpi_ids


def test_metric_catalog_exposes_every_presented_family_without_faking_batch_support():
    expected = {
        "llm": 6,
        "rag": 5,
        "agent": 7,
        "safety": 9,
        "ops": 5,
        "nlp": 5,
    }

    for family, count in expected.items():
        assert len([metric_id for metric_id in METRIC_CATALOG if metric_id.startswith(f"{family}.")]) == count

    batch_only = {
        "safety.violence",
        "safety.sexual",
        "safety.self_harm",
        "safety.hate_unfairness",
        "safety.protected_material",
        "safety.indirect_attack",
        "safety.code_vulnerability",
    }
    assert {
        metric_id
        for metric_id, metric in METRIC_CATALOG.items()
        if metric.execution_mode == "batch"
    } == batch_only
    assert all(not METRIC_CATALOG[metric_id].available_in_run for metric_id in batch_only)
